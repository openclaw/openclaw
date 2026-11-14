import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { getFileLockProcessStartTime, isPidAlive } from "../shared/pid-alive.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { extractSqliteTableSchema } from "./sqlite-schema-sql.js";
import {
  createManagedHandoffTempDirTracker,
  readManagedHandoffArtifacts,
} from "./update-managed-service-handoff-artifacts.test-support.js";
import {
  createManagedServiceChildMock as createChild,
  createReadyManagedServiceChild,
} from "./update-managed-service-handoff-command.test-support.js";
import {
  scopeWrapperSource,
  useHandoffFixtureReceipts,
  waitForOrphanExit,
} from "./update-managed-service-handoff-cross-process.test-support.js";
import type { ManagedServiceUpdateHandoffParams } from "./update-managed-service-handoff-types.js";
import { writeConcurrentManagedHandoffParams } from "./update-managed-service-handoff.test-support.js";
import { pathExists } from "./update-managed-service-native.test-support.js";

const spawnMock = vi.hoisted(() => vi.fn());
const tempDirs = createManagedHandoffTempDirTracker();
const handoffParents = new Map<string, import("node:child_process").ChildProcess>();
const mockedHandoffLeaseCleanups = new Set<() => void>();
const receipts = useHandoffFixtureReceipts();
type ConcurrentParams = Parameters<typeof writeConcurrentManagedHandoffParams>[0];

function createReadyChild(_command: string, args: string[]) {
  return createReadyManagedServiceChild(args, mockedHandoffLeaseCleanups);
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
  spawnMock.mockReset().mockImplementation(createReadyChild);
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
  mockedHandoffLeaseCleanups.forEach((cleanup) => cleanup());
  await tempDirs.cleanup();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function startHandoff(
  root: string,
  handoffId: string,
  overrides: Partial<ManagedServiceUpdateHandoffParams> = {},
) {
  const { startManagedServiceUpdateHandoff } = await import("./update-managed-service-handoff.js");
  const started = await startManagedServiceUpdateHandoff({
    root,
    restartDrainTimeoutMs: 300_000,
    parentPid: process.pid,
    execPath: "/usr/local/bin/node",
    argv1: "/opt/openclaw/openclaw.mjs",
    handoffId,
    meta: { handoffId },
    ...overrides,
  });
  tempDirs.add(path.dirname(started.logPath));
  return started;
}

function currentStartIdentity() {
  const identity = getFileLockProcessStartTime(process.pid);
  if (identity === null) {
    throw new Error("expected the live fixture process to have a stable start identity");
  }
  return String(identity);
}

async function prepareConcurrentHandoffHelper() {
  const tmpDir = tempDirs.make("openclaw-handoff-concurrent-test-");
  await startHandoff(tmpDir, "fixture-handoff", {
    timeoutMs: 1_800_000,
    restartDelayMs: 0,
    env: { OPENCLAW_STATE_DIR: tmpDir },
  });

  const [, args] = spawnMock.mock.calls.at(-1) as unknown as [string, string[]];
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
    writeParams: (name: string, commandArgv: string[], overrides: Partial<ConcurrentParams> = {}) =>
      writeConcurrentManagedHandoffParams(
        { tmpDir, baseParams, name, owner: `handoff-${name}`, commandArgv, ...overrides },
        handoffParents,
      ),
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

function readLease(
  params: Record<string, unknown>,
  columns = "owner, payload_json",
  owner?: string,
) {
  using database = new DatabaseSync(String(params.updateLeaseDatabasePath), { readOnly: true });
  const where = owner === undefined ? "" : " AND owner = ?";
  return database
    .prepare(`SELECT ${columns} FROM managed_update_handoffs WHERE install_root = ?${where}`)
    .get(String(params.updateLeaseKey), ...(owner === undefined ? [] : [owner]));
}

function seedLease(
  params: Record<string, unknown>,
  owner: string,
  payload: string,
  updatedAt = Date.now(),
) {
  // startHandoff already created and secured this exact coordinator database.
  using database = new DatabaseSync(String(params.updateLeaseDatabasePath));
  database
    .prepare(
      "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(String(params.updateLeaseKey), owner, payload, updatedAt);
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

function driveHandoffProtocol(
  child: import("node:child_process").ChildProcess,
  paramsPath: string,
): void {
  if (!child.stdout) {
    return;
  }
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (line === "OPENCLAW_UPDATE_HANDOFF_READY") {
      child.stdin?.write("park\n");
    } else if (line === "parked") {
      child.stdin?.write("commit\n");
    } else if (line === "committed") {
      handoffParents.get(paramsPath)?.stdin?.end();
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
    const result = await startHandoff("/tmp/openclaw", "replacement-handoff");

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
      const { spawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const { cancelManagedServiceUpdateHandoff, claimManagedServiceUpdateHandoff } =
        await import("./update-managed-service-handoff.js");
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
        const started = await startHandoff(tmpDir, handoffId, {
          restartDrainTimeoutMs: 5_000,
          restartDelayMs: 0,
          execPath: process.execPath,
          supervisor: "systemd",
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
          } else if (replacement === "identity" || replacement === "live") {
            const executor =
              replacement === "identity"
                ? {
                    pid: helperPid,
                    startIdentity: `${helperIdentity.executor.startIdentity}-mismatched`,
                  }
                : { pid: process.pid, startIdentity: currentStartIdentity() };
            payload = JSON.stringify({ ...helperIdentity, version: 2, executor });
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
        expect(readLease(helperParams)).toEqual(reclaimed ? undefined : originalRow!);
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
    const { tmpDir, writeParams, run } = await prepareConcurrentHandoffHelper();
    const markerPath = path.join(tmpDir, "invalid-parent-update-ran");
    const paramsPath = await writeParams("invalid-parent", markerCommand(markerPath));
    const params = JSON.parse(await fs.readFile(paramsPath, "utf8")) as Record<string, unknown>;
    const parentStartIdentity = currentStartIdentity();
    await fs.writeFile(
      paramsPath,
      JSON.stringify({
        ...params,
        parentPid: process.pid,
        parentStartIdentity: identity === "current" ? parentStartIdentity : identity,
      }),
    );
    const invalidPayload = JSON.stringify({
      version: 1,
      pid: process.pid,
      startIdentity: null,
    });
    const invalidUpdatedAt = Date.now();
    if (invalidOwner) {
      seedLease(params, "unverifiable-owner", invalidPayload, invalidUpdatedAt);
    }
    try {
      const result = await run(paramsPath);

      expect(result.code).toBe(1);
      expect(result.stdout).not.toContain("OPENCLAW_UPDATE_HANDOFF_READY");
      await expect(pathExists(markerPath)).resolves.toBe(false);
      expect(readLease(params, "owner, payload_json, updated_at")).toEqual(
        invalidOwner
          ? {
              owner: "unverifiable-owner",
              payload_json: invalidPayload,
              updated_at: invalidUpdatedAt,
            }
          : undefined,
      );
    } finally {
      if (invalidOwner) {
        deleteLease(params);
      }
    }
  });

  it("preserves a live durable owner when its current start identity cannot be observed", async () => {
    const { tmpDir, baseParams, writeParams, run } = await prepareConcurrentHandoffHelper();
    const ownerStartIdentity = currentStartIdentity();
    const owner = "identity-probe-unavailable-owner";
    const payload = JSON.stringify({
      version: 2,
      executor: { pid: process.pid, startIdentity: ownerStartIdentity },
      helper: { pid: process.pid, startIdentity: ownerStartIdentity },
      action: { kind: "update" },
    });
    seedLease(baseParams, owner, payload);
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
    const paramsPath = await writeParams("identity-probe-unavailable", markerCommand(markerPath));
    try {
      const result = await run(paramsPath, {
        ...process.env,
        NODE_OPTIONS: `--require ${preloadPath}`,
      });

      expect(result, result.stderr).toMatchObject({
        code: 0,
        stdout: expect.stringContaining(`HANDOFF_BUSY ${owner}`),
      });
      expect(readLease(baseParams)).toEqual({ owner, payload_json: payload });
      await expect(pathExists(markerPath)).resolves.toBe(false);
    } finally {
      deleteLease(baseParams, owner);
    }
  });

  it("releases exact helper ownership when cancellation cannot record its terminal sentinel", async () => {
    const { tmpDir, baseParams, writeParams, spawn } = await prepareConcurrentHandoffHelper();
    const markerPath = path.join(tmpDir, "sentinel-failure-updater-ran");
    const paramsPath = await writeParams("sentinel-failure", markerCommand(markerPath));
    const stateDatabasePath = String(baseParams.stateDatabasePath);
    await fs.mkdir(path.dirname(stateDatabasePath), { recursive: true });
    {
      using stateDb = new DatabaseSync(stateDatabasePath);
      stateDb.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "gateway_restart_sentinel"));
      stateDb.exec(`
        CREATE TRIGGER reject_update_sentinel_write
        BEFORE INSERT ON gateway_restart_sentinel
        WHEN NEW.sentinel_key = 'current'
        BEGIN SELECT RAISE(ABORT, 'sentinel write rejected'); END;
      `);
    }
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
      expect(readLease(baseParams, "owner")).toBeUndefined();
      const log = await fs.readFile(path.join(tmpDir, "sentinel-failure.log"), "utf8");
      expect(log).toContain("failed to write update sentinel failure");
      expect(log).toContain("sentinel write rejected");
      await expect(pathExists(markerPath)).resolves.toBe(false);
    } finally {
      if (helper.exitCode === null && helper.signalCode === null) {
        helper.kill("SIGKILL");
      }
      deleteLease(baseParams, "handoff-sentinel-failure");
    }
  });

  it.runIf(process.platform === "win32")(
    "reclaims a reused Windows PID with a different creation identity",
    async () => {
      const { tmpDir, baseParams, writeParams, run } = await prepareConcurrentHandoffHelper();
      const commandStartedPath = path.join(tmpDir, "windows-reused-pid-started");
      seedLease(
        baseParams,
        "stale-windows-owner",
        JSON.stringify({ version: 1, pid: process.pid, startIdentity: "0" }),
      );
      const paramsPath = await writeParams(
        "windows-reused-pid",
        markerCommand(commandStartedPath, baseParams.updateLeaseKey),
      );

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
      const paramsPath = await writeParams(
        "unsafe-lease-path",
        markerCommand(commandStartedPath),
        symlinked
          ? { leaseDatabasePath: path.join(leaseLink, "managed-update-handoffs.sqlite") }
          : {},
      );

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
      const firstParamsPath = await writeParams("orphan-first", [
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
      ]);
      const secondParamsPath = await writeParams(
        "orphan-second",
        markerCommand(secondStartedPath),
        {
          stateDatabasePath: path.join(tmpDir, "profile-b", "openclaw.sqlite"),
        },
      );
      const thirdParamsPath = await writeParams(
        "orphan-third",
        markerCommand(thirdStartedPath, baseParams.updateLeaseKey),
      );

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
          const row = readLease(baseParams, "payload_json", "handoff-orphan-first");
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
