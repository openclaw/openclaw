// Cross-process managed update handoff lease behavior.
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { isPidAlive } from "../shared/pid-alive.js";
import {
  createManagedHandoffTempDirTracker,
  readManagedHandoffArtifacts,
} from "./update-managed-service-handoff-artifacts.test-support.js";
import {
  scopeWrapperSource,
  useHandoffFixtureReceipts,
  waitForOrphanExit,
} from "./update-managed-service-handoff-cross-process.test-support.js";
import {
  signalMockManagedUpdateHandoffReady,
  writeConcurrentManagedHandoffParams,
} from "./update-managed-service-handoff.test-support.js";
import { pathExists } from "./update-managed-service-native.test-support.js";

const spawnMock = vi.hoisted(() => vi.fn());
const tempDirs = createManagedHandoffTempDirTracker();
const handoffParents = new Map<string, import("node:child_process").ChildProcess>();
const mockedHandoffLeaseCleanups = new Set<() => void>();
const receipts = useHandoffFixtureReceipts();

function createChild() {
  return Object.assign(new EventEmitter(), {
    pid: process.pid,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    unref: vi.fn(),
  });
}

function createReadyChild(_command: string, args: string[]) {
  const child = createChild();
  process.nextTick(signalMockManagedUpdateHandoffReady, {
    child,
    paramsPath: readManagedHandoffArtifacts(args).paramsPath,
    cleanups: mockedHandoffLeaseCleanups,
  });
  return child;
}

vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessModule } =
    await import("../gateway/server-methods/node-child-process.test-support.js");
  return mockNodeChildProcessModule({
    spawn: spawnMock as unknown as typeof import("node:child_process").spawn,
  });
});

vi.mock("../daemon/systemd-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd-scope.js")>()),
  findSystemdGatewayInstallation: vi.fn(async () => ({ kind: "none" })),
}));

beforeEach(async () => {
  // Competing helpers share this fixture's coordinator, never the operator's database.
  const tmpDirOwner = await import("./tmp-openclaw-dir.js");
  vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(
    tempDirs.make("openclaw-handoff-coordinator-"),
  );
  spawnMock.mockReset();
  spawnMock.mockImplementation(createReadyChild);
});

afterEach(async () => {
  await Promise.all(
    [...handoffParents.values()].map(async (parent) => {
      if (parent.exitCode !== null || parent.signalCode !== null) {
        return;
      }
      const closed = once(parent, "close");
      parent.stdin?.end();
      await closed;
    }),
  );
  handoffParents.clear();
  for (const cleanup of mockedHandoffLeaseCleanups) {
    cleanup();
  }
  await tempDirs.cleanup();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function prepareConcurrentHandoffHelper() {
  const { startManagedServiceUpdateHandoff } = await import("./update-managed-service-handoff.js");
  const tmpDir = tempDirs.make("openclaw-handoff-concurrent-test-");

  const started = await startManagedServiceUpdateHandoff({
    root: tmpDir,
    timeoutMs: 1_800_000,
    restartDrainTimeoutMs: 300_000,
    restartDelayMs: 0,
    parentPid: process.pid,
    execPath: "/usr/local/bin/node",
    argv1: "/opt/openclaw/openclaw.mjs",
    env: { OPENCLAW_STATE_DIR: tmpDir },
    handoffId: "fixture-handoff",
    meta: { handoffId: "fixture-handoff" },
  });

  const [, args] = spawnMock.mock.calls.at(-1) as unknown as [string, string[]];
  tempDirs.add(path.dirname(started.logPath));
  const { scriptPath: helperScriptPath, paramsPath } = readManagedHandoffArtifacts(args);
  const baseParams = JSON.parse(await fs.readFile(paramsPath, "utf-8")) as Record<string, unknown>;
  deleteLease(baseParams, String(baseParams.updateLeaseOwner));
  const { execFile, spawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const run = async (helperParamsPath: string, env?: NodeJS.ProcessEnv) =>
    await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        [helperScriptPath, helperParamsPath],
        { cwd: tmpDir, encoding: "utf8", ...(env ? { env } : {}) },
        (error, stdout, stderr) => {
          handoffParents.get(helperParamsPath)?.stdin?.end();
          const childError = error as NodeJS.ErrnoException | null;
          resolve({
            code: typeof childError?.code === "number" ? childError.code : 0,
            stdout,
            stderr,
          });
        },
      );
      driveHandoffProtocol(child, helperParamsPath);
    });
  return {
    tmpDir,
    baseParams,
    writeParams: (
      params: Omit<Parameters<typeof writeConcurrentHandoffParams>[0], "tmpDir" | "baseParams">,
    ) => writeConcurrentHandoffParams({ tmpDir, baseParams, ...params }),
    run,
    spawn: (helperParamsPath: string) =>
      spawn(process.execPath, [helperScriptPath, helperParamsPath], {
        cwd: tmpDir,
        stdio: ["pipe", "pipe", "pipe"],
      }),
  };
}

function deleteLease(params: Record<string, unknown>, owner?: string) {
  using database = new DatabaseSync(String(params.updateLeaseDatabasePath));
  const where = owner === undefined ? "" : " AND owner = ?";
  database
    .prepare(`DELETE FROM managed_update_handoffs WHERE install_root = ?${where}`)
    .run(String(params.updateLeaseKey), ...(owner === undefined ? [] : [owner]));
}

function readLease(databasePath: string, leaseKey: string, columns = "owner, payload_json") {
  using database = new DatabaseSync(databasePath, { readOnly: true });
  return database
    .prepare(`SELECT ${columns} FROM managed_update_handoffs WHERE install_root = ?`)
    .get(leaseKey);
}

async function seedLease(
  params: Record<string, unknown>,
  owner: string,
  payload: string,
  updatedAt = Date.now(),
  upsert = false,
) {
  const databasePath = String(params.updateLeaseDatabasePath);
  await fs.mkdir(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  {
    using database = new DatabaseSync(databasePath);
    database.exec(
      "CREATE TABLE IF NOT EXISTS managed_update_handoffs (install_root TEXT NOT NULL PRIMARY KEY, owner TEXT NOT NULL, payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;",
    );
    database
      .prepare(
        "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)" +
          (upsert
            ? " ON CONFLICT(install_root) DO UPDATE SET owner = excluded.owner, payload_json = excluded.payload_json, updated_at = excluded.updated_at"
            : ""),
      )
      .run(String(params.updateLeaseKey), owner, payload, updatedAt);
  }
  if (process.platform !== "win32") {
    await fs.chmod(databasePath, 0o600);
  }
}

function markerCommand(markerPath: string, root?: unknown) {
  return [
    process.execPath,
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran");` +
      (root === undefined
        ? ""
        : `process.stdout.write(JSON.stringify({status:"ok",root:${JSON.stringify(root)}}))`),
  ];
}

const writeConcurrentHandoffParams = (
  params: Parameters<typeof writeConcurrentManagedHandoffParams>[0],
) => writeConcurrentManagedHandoffParams(params, handoffParents);

function driveHandoffProtocol(
  child: import("node:child_process").ChildProcess,
  paramsPath: string,
): void {
  let buffered = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    buffered += chunk.toString();
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line === "OPENCLAW_UPDATE_HANDOFF_READY") {
        child.stdin?.write("park\n");
      } else if (line === "parked") {
        child.stdin?.write("commit\n");
      } else if (line === "committed") {
        handoffParents.get(paramsPath)?.stdin?.end();
      }
    }
  });
}

describe("managed service update handoff cross-process lease", () => {
  it("joins the durable owner reported by a replacement helper", async () => {
    const child = createChild();
    spawnMock.mockReturnValueOnce(child);
    process.nextTick(() => {
      child.stdout.write("HANDOFF_BUSY active-handoff\n");
      setImmediate(() => child.emit("exit", 0, null));
    });
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");

    const result = await startManagedServiceUpdateHandoff({
      root: "/tmp/openclaw",
      restartDrainTimeoutMs: 300_000,
      parentPid: process.pid,
      execPath: "/usr/local/bin/node",
      argv1: "/opt/openclaw/openclaw.mjs",
      handoffId: "replacement-handoff",
      meta: { handoffId: "replacement-handoff" },
    });
    tempDirs.add(path.dirname(result.logPath));

    expect(result).toMatchObject({
      status: "joined",
      handoffId: "active-handoff",
      command: "openclaw update --yes",
    });
    expect(result).not.toHaveProperty("pid");
  });

  it.runIf(process.platform !== "win32").for([
    { label: "its exact dead helper", replacement: "exact", reclaimed: true },
    { label: "a mismatched owner", replacement: "owner", reclaimed: false },
    { label: "a mismatched helper identity", replacement: "identity", reclaimed: false },
    { label: "another live process", replacement: "live", reclaimed: false },
    { label: "an unknown malformed process identity", replacement: "unknown", reclaimed: false },
  ] as const)(
    "claims a separate systemd scope helper and fences cancellation against $label",
    async ({ replacement, reclaimed }, { signal }) => {
      const { getFileLockProcessStartTime } = await import("../shared/pid-alive.js");
      const { spawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const {
        cancelManagedServiceUpdateHandoff,
        claimManagedServiceUpdateHandoff,
        startManagedServiceUpdateHandoff,
      } = await import("./update-managed-service-handoff.js");
      const tmpDir = tempDirs.make("openclaw-handoff-scope-wrapper-");
      const helperExitPath = path.join(tmpDir, "nested-helper-exited");
      const launcherPath = path.join(tmpDir, "systemd-run");
      await fs.writeFile(launcherPath, scopeWrapperSource(helperExitPath), { mode: 0o700 });
      const helperExited = createDeferred();
      let launcherClosed: Promise<unknown> = Promise.resolve();
      spawnMock.mockImplementationOnce((...args: Parameters<typeof spawn>) => {
        const child = spawn(...args);
        launcherClosed = once(child, "close");
        let output = "";
        child.stdout?.on("data", (chunk: Buffer | string) => {
          output += chunk.toString();
          if (output.includes("helper-exited\n")) {
            helperExited.resolve();
          }
        });
        return child;
      });

      const handoffId = `scope-wrapper-${replacement}-${path.basename(tmpDir)}`;
      let launcher: import("node:child_process").ChildProcess | undefined;
      let helperPid = 0;
      let leaseDatabasePath: string | undefined;
      let leaseOwner = handoffId;
      try {
        const started = await startManagedServiceUpdateHandoff({
          root: tmpDir,
          restartDrainTimeoutMs: 5_000,
          restartDelayMs: 0,
          parentPid: process.pid,
          execPath: process.execPath,
          argv1: "/opt/openclaw/openclaw.mjs",
          supervisor: "systemd",
          handoffId,
          meta: { handoffId },
          env: {
            OPENCLAW_STATE_DIR: tmpDir,
            PATH: `${tmpDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        });
        if (started.status !== "started" || !started.pid) {
          throw new Error("expected the systemd scope wrapper to start a real handoff");
        }
        launcher = spawnMock.mock.results.at(-1)?.value as
          | import("node:child_process").ChildProcess
          | undefined;
        tempDirs.add(path.dirname(started.logPath));
        const [, args] = spawnMock.mock.calls.at(-1) as unknown as [string, string[]];
        const helperParams = JSON.parse(
          await fs.readFile(readManagedHandoffArtifacts(args).paramsPath, "utf8"),
        ) as {
          updateLeaseDatabasePath: string;
          updateLeaseKey: string;
        };
        leaseDatabasePath = helperParams.updateLeaseDatabasePath;
        const identity = {
          kind: "managed-update-handoff" as const,
          handoffId,
          installRoot: started.installRoot,
        };
        let originalRow: { owner: string; payload_json: string };
        {
          using leaseDatabase = new DatabaseSync(leaseDatabasePath);
          const current = leaseDatabase
            .prepare(
              "SELECT owner, payload_json FROM managed_update_handoffs WHERE install_root = ?",
            )
            .get(helperParams.updateLeaseKey) as
            | { owner: string; payload_json: string }
            | undefined;
          if (!current) {
            throw new Error("expected the nested handoff helper to own its durable lease");
          }
          originalRow = current;
          const helperIdentity = JSON.parse(current.payload_json) as {
            executor: { pid: number; startIdentity: string };
          };
          helperPid = helperIdentity.executor.pid;

          expect(helperPid).not.toBe(started.pid);
          expect(launcher?.pid).toBe(started.pid);
          expect(isPidAlive(helperPid)).toBe(true);
          expect(claimManagedServiceUpdateHandoff(identity)).toBe(true);

          process.kill(helperPid, "SIGKILL");
          await withinTest(
            awaitGateBeforeSettlement(
              helperExited.promise,
              launcherClosed,
              "launcher exited before its helper",
            ),
            signal,
          );
          await expect(fs.readFile(helperExitPath, "utf8")).resolves.toBe(String(helperPid));
          expect(isPidAlive(helperPid)).toBe(false);
          expect(isPidAlive(started.pid)).toBe(true);
          expect(claimManagedServiceUpdateHandoff(identity)).toBe(false);

          let payload = current.payload_json;
          if (replacement === "owner") {
            leaseOwner = `${handoffId}-foreign`;
          } else if (replacement === "identity") {
            payload = JSON.stringify({
              ...helperIdentity,
              version: 2,
              executor: {
                pid: helperPid,
                startIdentity: `${helperIdentity.executor.startIdentity}-mismatched`,
              },
            });
          } else if (replacement === "live") {
            const liveStartIdentity = getFileLockProcessStartTime(process.pid);
            if (liveStartIdentity === null) {
              throw new Error("expected the live replacement to have a stable process identity");
            }
            payload = JSON.stringify({
              ...helperIdentity,
              version: 2,
              executor: { pid: process.pid, startIdentity: String(liveStartIdentity) },
            });
          } else if (replacement === "unknown") {
            payload = JSON.stringify({ version: 1, pid: helperPid, startIdentity: null });
          }
          if (replacement !== "exact") {
            leaseDatabase
              .prepare(
                "UPDATE managed_update_handoffs SET owner = ?, payload_json = ? WHERE install_root = ? AND owner = ?",
              )
              .run(leaseOwner, payload, helperParams.updateLeaseKey, handoffId);
            originalRow = { owner: leaseOwner, payload_json: payload };
          }
        }

        await expect(cancelManagedServiceUpdateHandoff(identity)).resolves.toBe(
          reclaimed ? "restored-in-process" : false,
        );
        expect(readLease(leaseDatabasePath, helperParams.updateLeaseKey)).toEqual(
          reclaimed ? undefined : originalRow!,
        );
      } finally {
        if (helperPid > 0 && isPidAlive(helperPid)) {
          process.kill(helperPid, "SIGKILL");
        }
        if (launcher?.pid && isPidAlive(launcher.pid)) {
          launcher.kill("SIGKILL");
        }
        await launcherClosed;
        if (leaseDatabasePath) {
          deleteLease(
            { updateLeaseDatabasePath: leaseDatabasePath, updateLeaseKey: tmpDir },
            leaseOwner,
          );
        }
      }
    },
  );

  it.each([
    ["an unavailable parent start identity", null, false],
    ["a reused parent start identity", "0", false],
    ["an existing live owner with a null start identity", "current", true],
  ])("rejects %s before announcing ownership", async (_label, identity, invalidOwner) => {
    const { getFileLockProcessStartTime } = await import("../shared/pid-alive.js");

    const { tmpDir, writeParams, run } = await prepareConcurrentHandoffHelper();
    const markerPath = path.join(tmpDir, "invalid-parent-update-ran");
    const paramsPath = await writeParams({
      name: "invalid-parent",
      owner: "invalid-parent-owner",
      commandArgv: markerCommand(markerPath),
    });
    const params = JSON.parse(await fs.readFile(paramsPath, "utf8")) as Record<string, unknown>;
    const currentStartIdentity = getFileLockProcessStartTime(process.pid);
    if (currentStartIdentity === null) {
      throw new Error("expected the live parent to have a stable start identity");
    }
    await fs.writeFile(
      paramsPath,
      JSON.stringify({
        ...params,
        parentPid: process.pid,
        parentStartIdentity: identity === "current" ? String(currentStartIdentity) : identity,
      }),
    );
    const leaseDatabasePath = String(params.updateLeaseDatabasePath);
    const leaseKey = String(params.updateLeaseKey);
    const invalidPayload = JSON.stringify({
      version: 1,
      pid: process.pid,
      startIdentity: null,
    });
    const invalidUpdatedAt = Date.now();
    if (invalidOwner) {
      await seedLease(params, "unverifiable-owner", invalidPayload, invalidUpdatedAt);
    }
    try {
      const result = await run(paramsPath);

      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("OPENCLAW_UPDATE_HANDOFF_READY");
      await expect(pathExists(markerPath)).resolves.toBe(false);
      if (await pathExists(leaseDatabasePath)) {
        expect(readLease(leaseDatabasePath, leaseKey, "owner, payload_json, updated_at")).toEqual(
          invalidOwner
            ? {
                owner: "unverifiable-owner",
                payload_json: invalidPayload,
                updated_at: invalidUpdatedAt,
              }
            : undefined,
        );
      }
    } finally {
      if (invalidOwner) {
        deleteLease(params);
      }
    }
  });

  it("preserves a live durable owner when its current start identity cannot be observed", async () => {
    const { getFileLockProcessStartTime } = await import("../shared/pid-alive.js");
    const { tmpDir, baseParams, writeParams, run } = await prepareConcurrentHandoffHelper();
    const ownerStartIdentity = getFileLockProcessStartTime(process.pid);
    if (ownerStartIdentity === null) {
      throw new Error("expected the live lease owner to have a stable process identity");
    }
    const leaseDatabasePath = String(baseParams.updateLeaseDatabasePath);
    const leaseKey = String(baseParams.updateLeaseKey);
    const owner = "identity-probe-unavailable-owner";
    const payload = JSON.stringify({
      version: 2,
      executor: { pid: process.pid, startIdentity: String(ownerStartIdentity) },
      helper: { pid: process.pid, startIdentity: String(ownerStartIdentity) },
      action: { kind: "update" },
    });
    await seedLease(baseParams, owner, payload);
    const preloadPath = path.join(tmpDir, "unavailable-owner-identity.cjs");
    await fs.writeFile(
      preloadPath,
      `const fs = require("node:fs");
const childProcess = require("node:child_process");
const ownerPid = ${process.pid};
const readFileSync = fs.readFileSync;
fs.readFileSync = function(filePath, ...args) {
  if (filePath === "/proc/" + ownerPid + "/stat") {
    throw Object.assign(new Error("identity probe unavailable"), { code: "EIO" });
  }
  return readFileSync.call(this, filePath, ...args);
};
const spawnSync = childProcess.spawnSync;
childProcess.spawnSync = function(command, args, options) {
  if (args.some((argument) => String(argument).includes(String(ownerPid)))) {
    return { status: null, stdout: "", error: new Error("identity probe unavailable") };
  }
  return spawnSync.call(this, command, args, options);
};
`,
    );
    const markerPath = path.join(tmpDir, "identity-probe-unavailable-updater-ran");
    const paramsPath = await writeParams({
      name: "identity-probe-unavailable",
      owner: "competing-owner",
      commandArgv: markerCommand(markerPath),
    });
    try {
      const result = await run(paramsPath, {
        ...process.env,
        NODE_OPTIONS: `--require ${preloadPath}`,
      });

      expect(result, result.stderr).toMatchObject({
        code: 0,
        stdout: expect.stringContaining(`HANDOFF_BUSY ${owner}`),
      });
      expect(readLease(leaseDatabasePath, leaseKey)).toEqual({ owner, payload_json: payload });
      await expect(pathExists(markerPath)).resolves.toBe(false);
    } finally {
      deleteLease(baseParams, owner);
    }
  });

  it("releases exact helper ownership when cancellation cannot record its terminal sentinel", async () => {
    const { tmpDir, baseParams, writeParams, spawn } = await prepareConcurrentHandoffHelper();
    const markerPath = path.join(tmpDir, "sentinel-failure-updater-ran");
    const owner = "sentinel-failure-owner";
    const paramsPath = await writeParams({
      name: "sentinel-failure",
      owner,
      commandArgv: markerCommand(markerPath),
    });
    const stateDatabasePath = String(baseParams.stateDatabasePath);
    await fs.mkdir(path.dirname(stateDatabasePath), { recursive: true });
    {
      using stateDb = new DatabaseSync(stateDatabasePath);
      stateDb.exec(
        [
          "CREATE TABLE gateway_restart_sentinel (",
          "sentinel_key TEXT NOT NULL PRIMARY KEY, version INTEGER NOT NULL,",
          "kind TEXT NOT NULL, status TEXT NOT NULL, ts INTEGER NOT NULL,",
          "session_key TEXT, thread_id TEXT, delivery_channel TEXT, delivery_to TEXT,",
          "delivery_account_id TEXT, message TEXT, continuation_json TEXT, doctor_hint TEXT,",
          "stats_json TEXT, payload_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL",
          ") STRICT;",
          "CREATE TRIGGER reject_update_sentinel_write",
          "BEFORE INSERT ON gateway_restart_sentinel",
          "WHEN NEW.sentinel_key = 'current'",
          "BEGIN SELECT RAISE(ABORT, 'sentinel write rejected'); END;",
        ].join(" "),
      );
    }
    const leaseDatabasePath = String(baseParams.updateLeaseDatabasePath);
    const leaseKey = String(baseParams.updateLeaseKey);
    const helper = spawn(paramsPath);
    let output = "";
    helper.stdout.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.includes("OPENCLAW_UPDATE_HANDOFF_READY") && !output.includes("cancelled")) {
        helper.stdin.write("cancel\n");
      }
    });
    const exited = once(helper, "close");

    try {
      await expect(exited).resolves.toEqual([0, null]);
      expect(output).toContain("cancelled");
      expect(readLease(leaseDatabasePath, leaseKey, "owner")).toBeUndefined();
      const log = await fs.readFile(path.join(tmpDir, "sentinel-failure.log"), "utf8");
      expect(log).toContain("failed to write update sentinel failure");
      expect(log).toContain("sentinel write rejected");
      await expect(pathExists(markerPath)).resolves.toBe(false);
    } finally {
      if (helper.exitCode === null && helper.signalCode === null) {
        helper.kill("SIGKILL");
      }
      deleteLease(baseParams, owner);
    }
  });

  it.runIf(process.platform === "win32")(
    "reclaims a reused Windows PID with a different creation identity",
    async () => {
      const { tmpDir, baseParams, writeParams, run } = await prepareConcurrentHandoffHelper();
      const commandStartedPath = path.join(tmpDir, "windows-reused-pid-started");
      await seedLease(
        baseParams,
        "stale-windows-owner",
        JSON.stringify({ version: 1, pid: process.pid, startIdentity: "0" }),
        Date.now(),
        true,
      );
      const paramsPath = await writeParams({
        name: "windows-reused-pid",
        owner: "replacement-windows-owner",
        commandArgv: markerCommand(commandStartedPath, baseParams.updateLeaseKey),
      });

      const result = await run(paramsPath);

      expect(result, result.stderr).toMatchObject({
        code: 0,
        stdout: expect.stringContaining("OPENCLAW_UPDATE_HANDOFF_READY"),
      });
      await expect(pathExists(commandStartedPath)).resolves.toBe(true);
    },
  );

  it.runIf(process.platform !== "win32").each([true, false])(
    "rejects invalid coordinator input before running the updater (symlinked: %s)",
    async (symlinked) => {
      const { tmpDir, baseParams, writeParams, run } = await prepareConcurrentHandoffHelper();
      const leaseTarget = path.join(tmpDir, "lease-target");
      const leaseLink = path.join(tmpDir, "lease-link");
      const commandStartedPath = path.join(tmpDir, "unsafe-command-started");
      if (symlinked) {
        await fs.mkdir(leaseTarget);
        await fs.symlink(leaseTarget, leaseLink, "dir");
      } else {
        delete baseParams.updateLeaseDatabaseIdentity;
      }
      const paramsPath = await writeParams({
        name: "unsafe-lease-path",
        owner: "unsafe-lease-owner",
        ...(symlinked
          ? { leaseDatabasePath: path.join(leaseLink, "managed-update-handoffs.sqlite") }
          : {}),
        commandArgv: markerCommand(commandStartedPath),
      });

      const result = await run(paramsPath);

      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("OPENCLAW_UPDATE_HANDOFF_READY");
      await expect(pathExists(commandStartedPath)).resolves.toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a surviving updater owned across helper loss and profiles",
    async ({ signal }) => {
      const { tmpDir, baseParams, writeParams, run, spawn } =
        await prepareConcurrentHandoffHelper();
      const orphanPidPath = path.join(tmpDir, "orphan-pid");
      const secondStartedPath = path.join(tmpDir, "second-started");
      const thirdStartedPath = path.join(tmpDir, "third-started");
      const releaseOrphanPath = path.join(tmpDir, "release-orphan");
      const secondProfileStatePath = path.join(tmpDir, "profile-b", "openclaw.sqlite");
      const firstParamsPath = await writeParams({
        name: "orphan-first",
        owner: "handoff-orphan-first",
        commandArgv: [
          process.execPath,
          "-e",
          [
            'const fs = require("node:fs");',
            "(async () => {",
            `const { sendReceipt } = await import(${JSON.stringify(`data:text/javascript,${encodeURIComponent(receipts.clientSource() + "\nexport { sendReceipt };")}`)});`,
            `const pidPath = ${JSON.stringify(orphanPidPath)};`,
            // File existence signals readiness; never expose an empty PID as a dead updater.
            'fs.writeFileSync(pidPath + ".tmp", String(process.pid));',
            'fs.renameSync(pidPath + ".tmp", pidPath);',
            'sendReceipt(pidPath, "started");',
            `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseOrphanPath)})){clearInterval(timer);process.exit(0)}},10);`,
            "})();",
          ].join("\n"),
        ],
      });
      const secondParamsPath = await writeParams({
        name: "orphan-second",
        owner: "handoff-orphan-second",
        stateDatabasePath: secondProfileStatePath,
        commandArgv: markerCommand(secondStartedPath),
      });
      const thirdParamsPath = await writeParams({
        name: "orphan-third",
        owner: "handoff-orphan-third",
        commandArgv: markerCommand(thirdStartedPath, baseParams.updateLeaseKey),
      });

      const first = spawn(firstParamsPath);
      const firstClosed = once(first, "close");
      driveHandoffProtocol(first, firstParamsPath);
      let firstStdout = "";
      first.stdout.on("data", (chunk) => (firstStdout += chunk));
      let orphanPid = 0;
      try {
        await withinTest(
          receipts.startedBeforeSettlement(orphanPidPath, firstClosed),
          signal,
        ).catch(async (error: unknown) => {
          const log = await fs
            .readFile(path.join(tmpDir, "orphan-first.log"), "utf8")
            .catch(String);
          throw new Error(`Surviving updater did not become ready: ${log}`, { cause: error });
        });
        expect(firstStdout).toContain("OPENCLAW_UPDATE_HANDOFF_READY");
        await expect(pathExists(orphanPidPath)).resolves.toBe(true);
        const orphanPidContents = await fs.readFile(orphanPidPath, "utf8");
        orphanPid = Number(orphanPidContents);
        expect(
          isPidAlive(orphanPid),
          `updater PID bytes: ${JSON.stringify(orphanPidContents)}`,
        ).toBe(true);
        first.kill("SIGKILL");
        await firstClosed;

        const second = await run(secondParamsPath);
        expect(second, second.stderr).toMatchObject({
          code: 0,
          stdout: expect.stringContaining("HANDOFF_BUSY handoff-orphan-first"),
        });
        await expect(pathExists(secondStartedPath)).resolves.toBe(false);

        await fs.writeFile(releaseOrphanPath, "release");
        await waitForOrphanExit(orphanPid, signal);
        expect(isPidAlive(orphanPid)).toBe(false);

        const third = await run(thirdParamsPath);
        expect(third, third.stderr).toMatchObject({
          code: 0,
          stdout: expect.stringContaining("OPENCLAW_UPDATE_HANDOFF_READY"),
        });
        await expect(pathExists(thirdStartedPath)).resolves.toBe(true);
      } finally {
        if (first.exitCode === null) {
          first.kill("SIGKILL");
        }
        await firstClosed;
        // Join the launcher before reading its last child receipt; a failed readiness
        // assertion can otherwise leave an updater writing into a deleted fixture.
        orphanPid ||= Number(await fs.readFile(orphanPidPath, "utf8").catch(() => "0"));
        if (!orphanPid) {
          using database = new DatabaseSync(String(baseParams.updateLeaseDatabasePath));
          const row = database
            .prepare(
              "SELECT payload_json FROM managed_update_handoffs WHERE install_root = ? AND owner = ?",
            )
            .get(String(baseParams.updateLeaseKey), "handoff-orphan-first");
          const executor = row && JSON.parse(String(row.payload_json)).executor;
          if (executor?.pid !== first.pid) {
            orphanPid = executor?.pid ?? 0;
          }
        }
        await fs.writeFile(releaseOrphanPath, "release").catch(() => undefined);
        if (orphanPid > 0 && isPidAlive(orphanPid)) {
          process.kill(orphanPid, "SIGKILL");
          await waitForOrphanExit(orphanPid, signal);
          expect(isPidAlive(orphanPid)).toBe(false);
        }
      }
    },
  );
});
