import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { readRestartSentinelRowSync } from "./restart-sentinel-store.js";
import {
  createManagedHandoffTempDirTracker,
  readManagedHandoffArtifacts,
} from "./update-managed-service-handoff-artifacts.test-support.js";
import {
  createReadyManagedServiceChild,
  waitForHandoffResponse as waitForHandoffLine,
} from "./update-managed-service-handoff-command.test-support.js";
import { createManagedServiceBoundaryParent } from "./update-managed-service-handoff-process.test-support.js";

const testNodeExecPath = resolveTestNodeExecPath();

const { resolvePreferredOpenClawTmpDirMock, spawnMock } = vi.hoisted(() => ({
  resolvePreferredOpenClawTmpDirMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessModule } =
    await import("../gateway/server-methods/node-child-process.test-support.js");
  return mockNodeChildProcessModule({
    spawn: spawnMock as unknown as typeof import("node:child_process").spawn,
  });
});

vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
}));

const tempDirs = createManagedHandoffTempDirTracker();
const mockedHandoffLeaseCleanups = new Set<() => void>();
type GatewayRestartSentinelDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">;
type SentinelFixture = {
  version: number;
  revision?: number;
  payload: {
    kind: string;
    status: string;
    ts?: number;
    sessionKey?: string;
    threadId?: string;
    message?: string;
    continuation?: unknown;
    stats?: unknown;
  };
};

function pendingSentinel(
  handoffId: string,
  overrides: Partial<SentinelFixture["payload"]> = {},
): SentinelFixture {
  return {
    version: 1,
    revision: 100,
    payload: {
      kind: "update",
      status: "skipped",
      ts: 100,
      stats: { handoffId, reason: "managed-service-handoff-started" },
      ...overrides,
    },
  };
}

function failureSentinel(reason: string, handoffId?: string) {
  return {
    version: 1,
    payload: {
      kind: "update",
      status: "error",
      stats: { reason, ...(handoffId ? { handoffId } : {}) },
    },
  };
}

function withStateDatabase<T>(
  env: NodeJS.ProcessEnv,
  run: (db: DatabaseSync) => T,
  readOnly = true,
): T {
  using db = new DatabaseSync(resolveOpenClawStateSqlitePath(env), { readOnly });
  return run(db);
}

async function snapshotStateDatabase(env: NodeJS.ProcessEnv) {
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const { ctimeMs, ino, mode, mtimeMs } = await fs.stat(databasePath);
  return {
    bytes: await fs.readFile(databasePath),
    entries: (await fs.readdir(path.dirname(databasePath))).toSorted(),
    ctimeMs,
    ino,
    mode,
    mtimeMs,
  };
}

beforeEach(async () => {
  const coordinatorDir = await fs.realpath(tempDirs.make("openclaw-handoff-coordinator-"));
  resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
  spawnMock.mockReset();
  spawnMock.mockImplementation((_command: string, args: string[]) =>
    createReadyManagedServiceChild(args, mockedHandoffLeaseCleanups),
  );
});

afterEach(async () => {
  for (const cleanup of mockedHandoffLeaseCleanups) {
    cleanup();
  }
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
  vi.resetModules();
});

function writeRestartSentinelRow(env: NodeJS.ProcessEnv, sentinel: SentinelFixture): void {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  // Raw insertion deliberately permits malformed stats/continuation fixtures.
  const { payload: record, revision = Date.now() } = sentinel;
  executeSqliteQuerySync(
    db,
    stateDb.insertInto("gateway_restart_sentinel").values({
      sentinel_key: record.kind === "revision-floor" ? "revision-floor" : "current",
      version: 1,
      kind: record.kind,
      status: record.status,
      ts: record.ts ?? Date.now(),
      session_key: record.sessionKey ?? null,
      thread_id: record.threadId ?? null,
      message: record.message ?? null,
      continuation_json: record.continuation ? JSON.stringify(record.continuation) : null,
      stats_json: record.stats ? JSON.stringify(record.stats) : null,
      payload_json: JSON.stringify(record),
      updated_at_ms: revision,
    }),
  );
}

function replaceRestartSentinelRow(env: NodeJS.ProcessEnv, sentinel: SentinelFixture): void {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  executeSqliteQuerySync(
    db,
    stateDb.deleteFrom("gateway_restart_sentinel").where("sentinel_key", "=", "current"),
  );
  writeRestartSentinelRow(env, sentinel);
}

function readRestartSentinelPayload(env: NodeJS.ProcessEnv, key = "current"): unknown {
  using db = new DatabaseSync(resolveOpenClawStateSqlitePath(env), { readOnly: true });
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_sentinel")
      .select(["version", "payload_json", "updated_at_ms"])
      .where("sentinel_key", "=", key),
  );
  return row
    ? { version: row.version, payload: JSON.parse(row.payload_json), revision: row.updated_at_ms }
    : null;
}

async function createLegacyRestartSentinelTable(env: NodeJS.ProcessEnv): Promise<void> {
  const stateDatabasePath = resolveOpenClawStateSqlitePath(env);
  await fs.mkdir(path.dirname(stateDatabasePath), { recursive: true });
  withStateDatabase(
    env,
    (db) =>
      db.exec(`
      CREATE TABLE gateway_restart_sentinel (
        sentinel_key TEXT NOT NULL PRIMARY KEY,
        version INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        ts INTEGER NOT NULL,
        session_key TEXT,
        thread_id TEXT,
        payload_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `),
    false,
  );
}

async function runOwnershipHelper(params: {
  handoffId?: string;
  prepareStateDatabase?: (env: NodeJS.ProcessEnv) => Promise<void> | void;
  sentinel?: SentinelFixture;
  deepStatePath?: boolean;
  commandDelayMs?: number;
  commandExitCode?: number;
  runnerFault?: "closed-gate" | "unavailable-identity";
  observeUpdateExit?: boolean;
  whileHelperRunning?: (context: {
    env: NodeJS.ProcessEnv;
    logPath: string;
    updateExited: Promise<void>;
  }) => Promise<void> | void;
}) {
  const { spawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { startManagedServiceUpdateHandoff } = await import("./update-managed-service-handoff.js");
  const tmpDir = tempDirs.make("openclaw-handoff-ownership-test-");
  let stateDir = tmpDir;
  while (
    params.deepStatePath &&
    resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }).length <= 260
  ) {
    stateDir = path.join(stateDir, `segment-${"x".repeat(24)}`);
  }
  const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;

  const started = await startManagedServiceUpdateHandoff({
    root: tmpDir,
    timeoutMs: 1_800_000,
    restartDrainTimeoutMs: 300_000,
    parentPid: process.pid,
    execPath: "/usr/local/bin/node",
    argv1: "/opt/openclaw/openclaw.mjs",
    ...(params.handoffId ? { handoffId: params.handoffId } : {}),
    env,
    meta: {
      ...(params.handoffId ? { handoffId: params.handoffId } : {}),
      sessionKey: "agent:test:webchat:dm:user-123",
      continuationMessage: "continue after restart",
    },
  });
  const mockedLauncher = spawnMock.mock.results.at(-1)?.value as ReturnType<
    typeof createReadyManagedServiceChild
  >;
  mockedLauncher.emit("exit", 0, null);

  const [, args, spawnOptions] = spawnMock.mock.calls.at(-1) as unknown as [
    string,
    string[],
    { env: NodeJS.ProcessEnv; detached?: boolean; cwd?: string },
  ];
  tempDirs.add(path.dirname(started.logPath));
  const { scriptPath: helperScriptPath, paramsPath } = readManagedHandoffArtifacts(args);
  const helperParams = JSON.parse(await fs.readFile(paramsPath, "utf8")) as Record<string, unknown>;
  await params.prepareStateDatabase?.(env);
  if (params.sentinel !== undefined) {
    writeRestartSentinelRow(env, params.sentinel);
  }
  const { parent, parentClosed, parentPid, parentStartIdentity } =
    createManagedServiceBoundaryParent(spawn);
  const helperParamsPath = path.join(tmpDir, "helper-params.json");
  const logPath = path.join(tmpDir, "handoff.log");
  const updaterPath = path.join(tmpDir, "updater-ran");
  const runnerClosedPath = path.join(tmpDir, "runner-closed-gate");
  const preloadPath = path.join(tmpDir, "runner-fault-preload.cjs");
  if (params.runnerFault) {
    await fs.writeFile(
      preloadPath,
      `const fs = require("node:fs");
const childProcess = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const originalSpawn = childProcess.spawn;
const closedPath = ${JSON.stringify(runnerClosedPath)};
let injected = false;
childProcess.spawn = function(command, args, options) {
  const child = originalSpawn.apply(this, arguments);
  if (injected || command !== process.execPath || !args.includes("--import") || !options.stdio.includes("ipc")) {
    return child;
  }
  injected = true;
  const input = child.stdio[4];
  const end = input.end;
  let leaseAtGate;
  let watchdogKilledRunner = false;
  let watchdog;
  child.once("close", (code, signal) => {
    clearTimeout(watchdog);
    fs.writeFileSync(closedPath, JSON.stringify({ pid: child.pid, code, signal, leaseAtGate, watchdogKilledRunner }), { mode: 0o600 });
  });
  const captureLease = () => {
    const db = new DatabaseSync(${JSON.stringify(helperParams.updateLeaseDatabasePath)}, { readOnly: true });
    try {
      leaseAtGate = db.prepare("SELECT owner, payload_json FROM managed_update_handoffs WHERE install_root = ?")
        .get(${JSON.stringify(helperParams.updateLeaseKey)});
    } finally {
      db.close();
    }
  };
  if (${JSON.stringify(params.runnerFault)} === "unavailable-identity") {
    // Exercise the real identity owner while preserving all unrelated process probes.
    const read = fs.readFileSync, execFile = childProcess.execFileSync;
    fs.readFileSync = function(file, ...args) {
      if (file === "/proc/" + child.pid + "/stat") {
        captureLease();
        throw Object.assign(new Error("fixture process identity unavailable"), {code:"EACCES"});
      }
      return read.call(this, file, ...args);
    };
    childProcess.execFileSync = function(command, args, ...rest) {
      if (command === "/bin/ps" && args.includes("lstart=") && args.includes(String(child.pid))) {
        captureLease();
        return "";
      }
      return execFile.call(this, command, args, ...rest);
    };
    // Keep the regression bounded on the broken owner; a passing repair must join first.
    watchdog = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      watchdogKilledRunner = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      child.kill("SIGKILL");
    }, 3000);
    return child;
  }
  input.end = function(...writeArgs) {
    input.end = end;
    captureLease();
    // End the admission sender after
    // lease binding, then let Node reject the original write and emit its error.
    input.end();
    return end.apply(this, writeArgs);
  };
  return child;
};
`,
    );
  }
  const exitObserverPath = path.join(tmpDir, "updater-exit-observer.cjs");
  if (params.observeUpdateExit) {
    await fs.writeFile(
      exitObserverPath,
      `const fs = require("node:fs");
const append = fs.appendFileSync;
fs.appendFileSync = function(file, data, ...args) {
  const result = append.call(this, file, data, ...args);
  if (file === ${JSON.stringify(logPath)} && String(data).includes("managed update update command exited code=")) {
    process.stdout.write("UPDATER_EXIT_RECORDED\\n");
  }
  return result;
};`,
    );
  }
  await fs.writeFile(
    helperParamsPath,
    JSON.stringify({
      ...helperParams,
      parentPid,
      parentStartIdentity: String(parentStartIdentity),
      commandArgv: [
        testNodeExecPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(updaterPath)},"ran");setTimeout(() => process.exit(${params.commandExitCode ?? 1}), ${params.commandDelayMs ?? 0})`,
      ],
      triageCommandArgv: [testNodeExecPath, "-e", "process.exit(0)", "--"],
      logPath,
      sensitivePaths: [],
    }),
  );

  const helper = spawn(testNodeExecPath, [helperScriptPath, helperParamsPath], {
    cwd: tmpDir,
    env: {
      ...spawnOptions.env,
      ...(params.runnerFault ? { NODE_OPTIONS: `--require ${preloadPath}` } : {}),
      ...(params.observeUpdateExit ? { NODE_OPTIONS: `--require ${exitObserverPath}` } : {}),
    },
    stdio: ["pipe", "pipe", params.runnerFault ? "pipe" : "ignore"],
  });
  const helperInput = helper.stdin;
  assert(helperInput, "expected the managed update helper to expose its control pipe");
  let stderr = "";
  helper.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const resultPromise = once(helper, "close");
  const updateExited = params.observeUpdateExit
    ? awaitGateBeforeSettlement(
        waitForHandoffLine(helper.stdout, "UPDATER_EXIT_RECORDED"),
        resultPromise,
        "helper exited before recording updater exit",
      )
    : Promise.resolve();
  void updateExited.catch(() => undefined);
  try {
    await waitForHandoffLine(helper.stdout, "OPENCLAW_UPDATE_HANDOFF_READY");
    const parked = waitForHandoffLine(helper.stdout, "parked");
    helperInput.write("park\n");
    await parked;
    const committed = waitForHandoffLine(helper.stdout, "committed");
    helperInput.write("commit\n");
    await committed;
    parent.stdin.end();
    await params.whileHelperRunning?.({ env, logPath, updateExited });
    expect(await resultPromise).toEqual([params.commandExitCode ?? 1, null]);
    await parentClosed;
    return {
      env,
      logPath,
      stderr,
      updaterPath,
      runnerClosedPath,
      leaseDatabasePath: String(helperParams.updateLeaseDatabasePath),
      leaseKey: String(helperParams.updateLeaseKey),
    };
  } finally {
    if (helper.exitCode === null && helper.signalCode === null) {
      helper.kill("SIGKILL");
    }
    if (parent.exitCode === null && parent.signalCode === null) {
      parent.kill("SIGKILL");
    }
    await Promise.all([resultPromise, parentClosed]);
  }
}

describe("managed service update handoff state ownership and sentinel persistence", () => {
  it("refuses fallback writes to externally owned state without the supervisor marker", async () => {
    let before: Awaited<ReturnType<typeof snapshotStateDatabase>> | undefined;
    const { env, logPath } = await runOwnershipHelper({
      commandExitCode: 7,
      prepareStateDatabase: async (stateEnv) => {
        const externalEnv = { ...stateEnv, OPENCLAW_SUPERVISOR_MODE: "external" };
        claimOpenClawStateOwnership("gateway-supervisor", { env: externalEnv });
        closeOpenClawStateDatabaseForTest();
        before = await snapshotStateDatabase(stateEnv);
      },
    });

    await expect(fs.readFile(logPath, "utf8")).resolves.toContain(
      "managed update update command exited code=7",
    );
    expect(await snapshotStateDatabase(env)).toEqual(before);
    await expect(fs.readFile(logPath, "utf8")).resolves.toMatch(
      /gateway-supervisor.*OPENCLAW_SUPERVISOR_MODE=external/u,
    );
  });

  it("rechecks external ownership after waiting for the state write lock", async ({ signal }) => {
    const ownership = {
      version: 1,
      mode: "external",
      managerId: "race-supervisor",
      claimedAt: Date.now(),
    };
    let claimant: DatabaseSync | undefined;
    let claimantTransactionOpen = false;
    let beforeSentinelRow: unknown;
    let helperResult: Awaited<ReturnType<typeof runOwnershipHelper>> | undefined;
    try {
      helperResult = await runOwnershipHelper({
        commandExitCode: 7,
        handoffId: "handoff-ownership-race",
        observeUpdateExit: true,
        prepareStateDatabase: async (stateEnv) => {
          writeRestartSentinelRow(stateEnv, pendingSentinel("handoff-ownership-race"));
          closeOpenClawStateDatabaseForTest();
          claimant = new DatabaseSync(resolveOpenClawStateSqlitePath(stateEnv));
          claimant.exec("BEGIN IMMEDIATE;");
          claimantTransactionOpen = true;
          claimant
            .prepare(
              "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
            )
            .run("gateway.supervision", JSON.stringify(ownership), ownership.claimedAt);
          beforeSentinelRow = claimant
            .prepare("SELECT * FROM gateway_restart_sentinel WHERE sentinel_key = ?")
            .get("current");
        },
        whileHelperRunning: async ({ logPath, updateExited }) => {
          await withinTest(updateExited, signal);
          await expect(fs.readFile(logPath, "utf8")).resolves.toContain(
            "managed update update command exited code=7",
          );
          await delay(100);
          assert(claimant, "expected the ownership claimant transaction to remain open");
          claimant.exec("COMMIT;");
          claimantTransactionOpen = false;
          claimant.close();
          claimant = undefined;
        },
      });
    } finally {
      if (claimantTransactionOpen) {
        try {
          claimant?.exec("ROLLBACK;");
        } catch {}
      }
      try {
        claimant?.close();
      } catch {}
    }

    assert(helperResult, "expected the detached helper to return a result");
    withStateDatabase(helperResult.env, (verifyDb) => {
      const ownershipRow = verifyDb
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
        .get("gateway.supervision") as { value_json?: unknown } | undefined;
      expect(ownershipRow?.value_json).toBe(JSON.stringify(ownership));
      expect(
        verifyDb
          .prepare("SELECT * FROM gateway_restart_sentinel WHERE sentinel_key = ?")
          .get("current"),
      ).toEqual(beforeSentinelRow);
    });
    await expect(fs.readFile(helperResult.logPath, "utf8")).resolves.toMatch(
      /race-supervisor.*OPENCLAW_SUPERVISOR_MODE=external/u,
    );
  });

  it.each(
    process.platform === "win32"
      ? (["closed-gate"] as const)
      : (["closed-gate", "unavailable-identity"] as const),
  )("joins the exact gated runner and records failure after %s", async (runnerFault) => {
    const handoffId = `handoff-runner-${runnerFault}`;
    const { env, stderr, logPath, updaterPath, runnerClosedPath, leaseDatabasePath, leaseKey } =
      await runOwnershipHelper({
        handoffId,
        runnerFault,
      });

    expect(stderr).not.toMatch(/Unhandled 'error' event|Error: write EPIPE/u);
    await expect(fs.access(updaterPath)).rejects.toMatchObject({ code: "ENOENT" });

    const runner = JSON.parse(await fs.readFile(runnerClosedPath, "utf8")) as {
      pid: number;
      leaseAtGate: { owner: string; payload_json: string };
      watchdogKilledRunner: boolean;
    };
    expect(runner.pid).toBeGreaterThan(0);
    expect(runner).toMatchObject({
      watchdogKilledRunner: false,
      leaseAtGate: { owner: handoffId },
    });
    const leaseAtGate = JSON.parse(runner.leaseAtGate.payload_json);
    expect(leaseAtGate).toMatchObject({
      version: 2,
      action: { kind: "update" },
      executor: { pid: runnerFault === "closed-gate" ? runner.pid : leaseAtGate.helper.pid },
    });
    await expect(fs.readFile(logPath, "utf8")).resolves.toContain(
      runnerFault === "closed-gate"
        ? "ERR_STREAM_WRITE_AFTER_END"
        : "process start identity is unavailable",
    );

    {
      using leaseDatabase = new DatabaseSync(leaseDatabasePath, { readOnly: true });
      expect(
        leaseDatabase
          .prepare("SELECT owner FROM managed_update_handoffs WHERE install_root = ?")
          .get(leaseKey),
      ).toBeUndefined();
    }

    expect(readRestartSentinelPayload(env)).toMatchObject(
      failureSentinel("managed-service-handoff-helper-failed", handoffId),
    );
  });

  it.runIf(process.platform === "win32")(
    "writes fallback state through the detached helper beyond MAX_PATH",
    async () => {
      const { env } = await runOwnershipHelper({
        deepStatePath: true,
        handoffId: "handoff-windows-long-path",
      });
      const statePath = resolveOpenClawStateSqlitePath(env);
      expect(statePath.startsWith("\\\\?\\")).toBe(false);
      expect(statePath.length).toBeGreaterThan(260);
      expect(readRestartSentinelPayload(env)).toMatchObject({
        payload: { status: "error" },
      });
    },
  );

  it("waits for a concurrent state writer before persisting the fallback failure", async () => {
    let lockReleased: Promise<void> | undefined;
    const { env } = await runOwnershipHelper({
      handoffId: "handoff-locked",
      prepareStateDatabase: async (stateEnv) => {
        openOpenClawStateDatabase({ env: stateEnv });
        closeOpenClawStateDatabaseForTest();
        const lock = new DatabaseSync(resolveOpenClawStateSqlitePath(stateEnv));
        lock.exec("BEGIN IMMEDIATE;");
        lockReleased = new Promise((resolve) => {
          setTimeout(() => {
            lock.exec("COMMIT;");
            lock.close();
            resolve();
          }, 200);
        });
      },
    });
    await lockReleased;

    expect(readRestartSentinelRowSync(openOpenClawStateDatabase({ env }).db)).toMatchObject({
      kind: "valid",
      sentinel: {
        version: 1,
        payload: {
          kind: "update",
          status: "error",
          sessionKey: "agent:test:webchat:dm:user-123",
        },
      },
    });
    if (process.platform !== "win32") {
      expect((await fs.stat(resolveOpenClawStateSqlitePath(env))).mode & 0o777).toBe(0o600);
    }
    expect(readRestartSentinelPayload(env)).toMatchObject(
      failureSentinel("managed-service-handoff-failed", "handoff-locked"),
    );
  });

  it.each(["continuation", "stats", "empty routing"] as const)(
    "uses canonical sentinel rows without overwriting invalid metadata (%s)",
    async (shape) => {
      let before: unknown;
      const { env } = await runOwnershipHelper({
        handoffId: "handoff-typed-row",
        prepareStateDatabase: (stateEnv) => {
          writeRestartSentinelRow(
            stateEnv,
            pendingSentinel("handoff-typed-row", {
              sessionKey: "",
              threadId: "",
              message: "",
              ...(shape === "continuation"
                ? { continuation: { kind: "agentTurn", message: 42 } }
                : {}),
              stats: {
                handoffId: "handoff-typed-row",
                reason: "managed-service-handoff-started",
                ...(shape === "stats" ? { durationMs: "invalid" } : {}),
              },
            }),
          );
          closeOpenClawStateDatabaseForTest();
          before = withStateDatabase(stateEnv, (db) =>
            db.prepare("SELECT * FROM gateway_restart_sentinel ORDER BY sentinel_key").all(),
          );
        },
      });
      withStateDatabase(env, (db) => {
        if (shape === "empty routing") {
          expect(
            db
              .prepare("SELECT * FROM gateway_restart_sentinel WHERE sentinel_key = 'current'")
              .get(),
          ).toMatchObject({ status: "error", session_key: "", thread_id: "", message: "" });
        } else {
          expect(
            db.prepare("SELECT * FROM gateway_restart_sentinel ORDER BY sentinel_key").all(),
          ).toEqual(before);
        }
      });
    },
  );

  it("repairs legacy restart sentinel columns without changing the database schema version", async () => {
    const { env } = await runOwnershipHelper({
      handoffId: "handoff-123",
      prepareStateDatabase: async (stateEnv) => {
        await createLegacyRestartSentinelTable(stateEnv);
        withStateDatabase(stateEnv, (db) => db.exec("PRAGMA user_version = 7"), false);
      },
    });

    withStateDatabase(env, (db) => {
      expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 7 });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([
        { name: "gateway_restart_sentinel" },
      ]);
      expect(readRestartSentinelRowSync(db)).toMatchObject({
        kind: "valid",
        sentinel: failureSentinel("managed-service-handoff-failed"),
      });
    });
  });

  it.each([false, true])(
    "preserves a newer sentinel (written during update=%s)",
    async (duringUpdate) => {
      const newerSentinel = duringUpdate
        ? { version: 1, revision: 200, payload: { kind: "restart", status: "ok", ts: 200 } }
        : pendingSentinel("newer-handoff", { message: "new handoff still pending" });
      const { env } = await runOwnershipHelper({
        handoffId: "old-handoff",
        sentinel: duringUpdate ? pendingSentinel("old-handoff") : newerSentinel,
        commandDelayMs: duringUpdate ? 200 : undefined,
        whileHelperRunning: !duringUpdate
          ? undefined
          : async ({ env: stateEnv }) => {
              await delay(50);
              replaceRestartSentinelRow(stateEnv, newerSentinel);
            },
      });
      expect(readRestartSentinelPayload(env)).toMatchObject(newerSentinel);
    },
  );

  it("advances the durable revision floor even when it is ahead of the clock", async () => {
    const futureRevision = Date.now() + 60_000;
    const { env } = await runOwnershipHelper({
      handoffId: "handoff-future-revision",
      sentinel: {
        ...pendingSentinel("handoff-future-revision", { kind: "revision-floor", ts: 123 }),
        revision: futureRevision,
      },
    });

    expect(readRestartSentinelPayload(env, "revision-floor")).toMatchObject({
      revision: futureRevision + 1,
    });
  });
});
