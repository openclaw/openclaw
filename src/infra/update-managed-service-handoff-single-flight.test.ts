import type { ChildProcess } from "node:child_process";
// Process-local handoff sharing complements the durable cross-process lease.
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  createManagedHandoffTempDirTracker,
  readManagedHandoffArtifacts,
} from "./update-managed-service-handoff-artifacts.test-support.js";
import type {
  ManagedServiceUpdateHandoffParams,
  ManagedServiceUpdateHandoffResult,
} from "./update-managed-service-handoff-types.js";
import {
  signalMockManagedUpdateHandoffReady,
  registerPreparedCoordinatorAdmissionTest,
  type MockManagedUpdateHandoffLeaseFailure,
} from "./update-managed-service-handoff.test-support.js";

const testNodeExecPath = resolveTestNodeExecPath();

const spawnMock = vi.hoisted(() => vi.fn());
const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn());
const forceKillChildProcessTreeMock = vi.hoisted(() => vi.fn());
const findSystemdGatewayInstallationMock = vi.hoisted(() =>
  vi.fn<typeof import("../daemon/systemd-scope.js").findSystemdGatewayInstallation>(async () => ({
    kind: "none",
  })),
);
// The coordinator must outlive mocked lease cleanup in afterEach.
const tempRoots = createManagedHandoffTempDirTracker();
const mockedHandoffLeaseCleanups = new Set<() => void>();
const parents = new Set<ChildProcess>();
const MOCK_INSTALL_ROOT = path.join(os.tmpdir(), `openclaw-handoff-single-flight-${process.pid}`);

function createReadyChild(
  pid: number,
  paramsPath: string,
  failure?: MockManagedUpdateHandoffLeaseFailure,
) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    unref: vi.fn(),
  });
  process.nextTick(() => {
    signalMockManagedUpdateHandoffReady({
      child,
      paramsPath,
      cleanups: mockedHandoffLeaseCleanups,
      ...(child.pid === process.pid ? {} : { startIdentity: 17 }),
      failure,
    });
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
  findSystemdGatewayInstallation: findSystemdGatewayInstallationMock,
}));

vi.mock("../process/child-process-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/child-process-tree.js")>()),
  forceKillChildProcessTree: forceKillChildProcessTreeMock,
}));

vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
}));

beforeEach(async () => {
  // Competing helpers share this fixture's coordinator, never the operator's database.
  resolvePreferredOpenClawTmpDirMock.mockReturnValue(
    tempRoots.make("openclaw-handoff-coordinator-"),
  );
  let pid = 24680;
  const liveChildren = new Set<number>();
  const processIdentity = await import("../shared/pid-alive.js");
  const parentStartIdentity = processIdentity.getFileLockProcessStartTime(process.pid);
  vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation((targetPid) =>
    targetPid === process.pid ? parentStartIdentity : liveChildren.has(targetPid) ? 17 : null,
  );
  vi.spyOn(processIdentity, "isPidAlive").mockImplementation(
    (targetPid) => targetPid === process.pid || liveChildren.has(targetPid),
  );
  vi.spyOn(processIdentity, "isPidDefinitelyDead").mockImplementation(
    (targetPid) => targetPid !== process.pid && !liveChildren.has(targetPid),
  );
  forceKillChildProcessTreeMock.mockReset();
  forceKillChildProcessTreeMock.mockImplementation((child: ReturnType<typeof createReadyChild>) => {
    child.stdout.destroy();
  });
  findSystemdGatewayInstallationMock.mockReset();
  findSystemdGatewayInstallationMock.mockResolvedValue({ kind: "none" });
  spawnMock.mockReset();
  spawnMock.mockImplementation((_command: string, args: string[]) => {
    const child = createReadyChild(pid++, readManagedHandoffArtifacts(args).paramsPath);
    liveChildren.add(child.pid);
    child.once("exit", () => liveChildren.delete(child.pid));
    return child;
  });
});

afterEach(async () => {
  for (const parent of parents) {
    parent.stdin?.end();
  }
  parents.clear();
  for (const cleanup of mockedHandoffLeaseCleanups) {
    cleanup();
  }
  for (const [, args] of spawnMock.mock.calls) {
    tempRoots.add(readManagedHandoffArtifacts(args).dir);
  }
  await tempRoots.cleanup();
  vi.restoreAllMocks();
  vi.resetModules();
});

const baseParams = {
  restartDrainTimeoutMs: 300_000,
  parentPid: process.pid,
  execPath: "/usr/local/bin/node",
  argv1: "/opt/openclaw/openclaw.mjs",
};

const mockedChild = (index = 0) =>
  spawnMock.mock.results[index]?.value as ReturnType<typeof createReadyChild>;
const realChild = (index = 0) => spawnMock.mock.results[index]?.value as ChildProcess;
const updatePayload = (pid: number, startIdentity: number) => ({
  version: 2,
  executor: { pid, startIdentity: String(startIdentity) },
  helper: { pid, startIdentity: String(startIdentity) },
  action: { kind: "update" },
});

async function writeMarkerUpdater(root: string) {
  const markerPath = path.join(root, "updater-ran");
  const updaterPath = path.join(root, "updater.cjs");
  await fs.writeFile(
    updaterPath,
    `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran")`,
  );
  return { markerPath, updaterPath };
}

function requireOwner(result: ManagedServiceUpdateHandoffResult) {
  if (result.status !== "started" || !result.pid) {
    throw new Error("expected owned helper");
  }
  return { ...result, pid: result.pid, kind: "managed-update-handoff" as const };
}

async function mockHandoffFixture() {
  const {
    startManagedServiceUpdateHandoff,
    claimManagedServiceUpdateHandoff: claim,
    transferManagedServiceUpdateHandoff: transfer,
    requestManagedServiceUpdateHandoffPark: park,
  } = await import("./update-managed-service-handoff.js");
  const start = (options: Partial<ManagedServiceUpdateHandoffParams>) =>
    startManagedServiceUpdateHandoff({
      ...baseParams,
      root: MOCK_INSTALL_ROOT,
      meta: {},
      ...options,
    });
  return { start, claim, transfer, park };
}

async function readHelperParams() {
  const [, args] = spawnMock.mock.calls[0] as [string, string[]];
  return JSON.parse(await fs.readFile(readManagedHandoffArtifacts(args).paramsPath, "utf8")) as {
    updateLeaseDatabasePath: string;
    stateDatabasePath: string;
  };
}

async function realHandoffFixture(prefix: string) {
  vi.restoreAllMocks();
  const { spawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  spawnMock.mockImplementation(spawn);
  const root = await fs.realpath(tempRoots.make(prefix));
  const parent = spawn(testNodeExecPath, ["-e", "process.stdin.resume()"], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  parents.add(parent);
  const { DatabaseSync } = await import("node:sqlite");
  function database<T>(
    file: string,
    readOnly: boolean,
    run: (db: InstanceType<typeof DatabaseSync>) => T,
  ): T {
    const db = new DatabaseSync(file, { readOnly });
    try {
      return run(db);
    } finally {
      db.close();
    }
  }
  const readRow = (file: string, sql: string, ...values: SQLInputValue[]) =>
    database(file, true, (db) => db.prepare(sql).get(...values));
  const execute = (file: string, sql: string, ...values: SQLInputValue[]) =>
    database(file, false, (db) => db.prepare(sql).run(...values));
  const {
    startManagedServiceUpdateHandoff,
    cancelManagedServiceUpdateHandoff: cancel,
    claimManagedServiceUpdateHandoff: claim,
    transferManagedServiceUpdateHandoff: transfer,
    requestManagedServiceUpdateHandoffPark: park,
  } = await import("./update-managed-service-handoff.js");
  const start = (argv1 = process.argv[1]) =>
    startManagedServiceUpdateHandoff({
      ...baseParams,
      root,
      parentPid: parent.pid,
      execPath: testNodeExecPath,
      argv1,
      env: { ...process.env, OPENCLAW_STATE_DIR: root },
      meta: {},
    });
  return { root, parent, start, cancel, claim, transfer, park, readRow, execute };
}

describe("managed service update handoff single-flight", () => {
  registerPreparedCoordinatorAdmissionTest({
    spawnMock,
    makeTempDir: (prefix) => tempRoots.make(prefix),
    setCoordinator: (directory) => {
      resolvePreferredOpenClawTmpDirMock.mockReturnValue(directory);
    },
  });
  it.each([false, true])(
    "awaits the pre-park notice and rechecks helper ownership (lost: %s)",
    async (lost) => {
      const { start, park: requestPark } = await mockHandoffFixture();
      const entered = createDeferredCore();
      const delivered = createDeferredCore();
      const started = requireOwner(
        await start({
          root: `${MOCK_INSTALL_ROOT}-notice-${lost}`,
          beforePark: async () => {
            entered.resolve();
            await delivered.promise;
          },
        }),
      );
      const child = mockedChild();
      const commands: string[] = [];
      child.stdin.on("data", (chunk: Buffer) => {
        commands.push(chunk.toString());
        child.stdout.write("parked\n");
      });
      const park = requestPark(started);
      await entered.promise;
      expect(commands).toEqual([]);
      if (lost) {
        child.emit("exit", 0, null);
      }
      delivered.resolve();
      await expect(park).resolves.toBe(!lost);
      expect(commands).toEqual(lost ? [] : ["park\n"]);
      if (!lost) {
        child.emit("exit", 0, null);
      }
    },
  );
  it.each([
    ["does not exist", "absent"],
    ["has malformed helper identity", "malformed"],
    ["belongs to a different owner", "wrong-owner"],
    ["identifies a dead helper", "dead-helper"],
    ["has no process start identity", "identity-unavailable"],
  ] as const)("rejects READY when the durable helper lease %s", async (_label, failure) => {
    if (failure === "identity-unavailable") {
      const startIdentity = vi.mocked(
        (await import("../shared/pid-alive.js")).getFileLockProcessStartTime,
      );
      const parentIdentity = startIdentity(process.pid);
      startIdentity.mockImplementation((pid) => (pid === process.pid ? parentIdentity : null));
    } else {
      spawnMock.mockImplementationOnce((_command: string, args: string[]) =>
        createReadyChild(process.pid, readManagedHandoffArtifacts(args).paramsPath, failure),
      );
    }
    const { start, claim } = await mockHandoffFixture();
    const identity = {
      kind: "managed-update-handoff" as const,
      handoffId: `invalid-ready-${failure}`,
      installRoot: `${MOCK_INSTALL_ROOT}-${failure}`,
    };

    await expect(
      start({
        root: identity.installRoot,
        handoffId: identity.handoffId,
      }),
    ).rejects.toThrow(
      failure === "identity-unavailable"
        ? "process start identity is unavailable"
        : /lease|helper|identity/u,
    );

    const child = mockedChild();
    expect(forceKillChildProcessTreeMock).toHaveBeenCalledExactlyOnceWith(child);
    expect(child.unref).not.toHaveBeenCalled();
    expect(claim(identity)).toBe(false);
  });

  it("rejects an unwritable dueling install before spawning or reserving ownership", async () => {
    const system = {
      scope: "system" as const,
      unitName: "openclaw-gateway.service",
      unitPath: "/etc/systemd/system/openclaw-gateway.service",
    };
    findSystemdGatewayInstallationMock.mockResolvedValue({
      kind: "dueling",
      system,
      user: {
        scope: "user",
        unitName: system.unitName,
        unitPath: "/fixture/user/" + system.unitName,
      },
    });
    const { start, claim } = await mockHandoffFixture();
    const root = await fs.realpath(tempRoots.make("openclaw-system-scope-"));
    const access = fs.access.bind(fs);
    const permission = vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
      if (String(file) === root && mode === (fs.constants.W_OK | fs.constants.X_OK)) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return access(file, mode);
    });

    await expect(
      start({
        root,
        handoffId: "system-handoff",
        supervisor: "systemd",
        env: { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway.service" },
      }),
    ).rejects.toMatchObject({
      reason: "managed-service-handoff-failed",
      message: expect.stringContaining("sudo systemctl restart openclaw-gateway.service"),
    });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(
      claim({
        kind: "managed-update-handoff",
        handoffId: "system-handoff",
        installRoot: root,
      }),
    ).toBe(false);

    permission.mockRestore();
    await expect(
      start({
        root,
        supervisor: "systemd",
        env: { OPENCLAW_STATE_DIR: root },
      }),
    ).resolves.toMatchObject({ status: "started" });
    expect(spawnMock).toHaveBeenCalledOnce();
    const owner = mockedChild();
    owner.emit("exit", 0, null);
  });

  it("shares one same-root helper until its lifecycle ends", async () => {
    const { start } = await mockHandoffFixture();
    const first = start({
      handoffId: "handoff-first",
      meta: { handoffId: "handoff-first" },
    });
    const second = start({
      handoffId: "handoff-second",
      meta: { handoffId: "handoff-second" },
    });

    const outcomes = await Promise.all([first, second]);
    expect(outcomes).toEqual([
      expect.objectContaining({ status: "started", handoffId: "handoff-first" }),
      expect.objectContaining({ status: "joined", handoffId: "handoff-first" }),
    ]);
    expect(outcomes[1]).not.toHaveProperty("installRoot");
    expect(spawnMock).toHaveBeenCalledOnce();

    const owner = mockedChild();
    owner.emit("exit", 0, null);
    const next = start({
      handoffId: "handoff-next",
      meta: { handoffId: "handoff-next" },
    });

    await expect(next).resolves.toMatchObject({
      status: "started",
      handoffId: "handoff-next",
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const nextOwner = mockedChild(1);
    nextOwner.emit("exit", 0, null);
  });

  it("transfers through Bun-style child pipes without stream-level unref", async () => {
    const commands: string[] = [];
    spawnMock.mockImplementationOnce((_command: string, args: string[]) => {
      const child = createReadyChild(process.pid, readManagedHandoffArtifacts(args).paramsPath);
      child.stdin.on("data", (chunk) => {
        const command = chunk.toString();
        commands.push(command);
        if (command === "transfer\n") {
          child.stdout.write("transferred\n");
        }
      });
      return child;
    });
    const { start, transfer } = await mockHandoffFixture();
    const root = `${MOCK_INSTALL_ROOT}-bun-pipes`;
    const started = requireOwner(
      await start({
        root,
        handoffId: "bun-pipes",
      }),
    );
    const child = mockedChild();
    expect("unref" in child.stdin).toBe(false);
    expect("unref" in child.stdout).toBe(false);

    await expect(transfer(started)).resolves.toBe(true);
    expect(commands).toEqual(["transfer\n"]);
    expect(child.unref).toHaveBeenCalledOnce();
    child.emit("exit", 0, null);
  });

  it.each([
    ["has exited before its ChildProcess notification", "dead"],
    ["reuses its PID for another process", "reused"],
    ["no longer exposes its process start identity", "unknown"],
  ])("rejects a helper claim when its operating-system process %s", async (_label, failure) => {
    const { start, claim, transfer, cancel } = await realHandoffFixture(
      "openclaw-helper-process-identity-",
    );
    const processIdentity = await import("../shared/pid-alive.js");
    try {
      const started = requireOwner(await start());
      expect(claim(started)).toBe(true);
      await expect(transfer(started)).resolves.toBe(true);
      if (failure === "dead") {
        vi.spyOn(processIdentity, "isPidAlive").mockReturnValue(false);
      } else {
        const helperStartIdentity = processIdentity.getFileLockProcessStartTime(started.pid);
        if (helperStartIdentity === null) {
          throw new Error("expected the real detached helper to have a process identity");
        }
        vi.spyOn(
          await import("../shared/pid-alive.js"),
          "getFileLockProcessStartTime",
        ).mockReturnValue(failure === "reused" ? helperStartIdentity + 1 : null);
      }
      expect(claim(started)).toBe(false);
      vi.restoreAllMocks();
      await expect(cancel(started)).resolves.toBe("restored-in-process");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("reclaims only its exact dead detached helper before reopening the install root", async () => {
    const { root, start, cancel, readRow, execute } = await realHandoffFixture(
      "openclaw-dead-handoff-owner-",
    );
    const processIdentity = await import("../shared/pid-alive.js");
    const { getFileLockProcessStartTime } = processIdentity;
    const { markerPath, updaterPath } = await writeMarkerUpdater(root);
    let leaseDatabasePath: string | undefined;
    let deadOwner: string | undefined;
    let replacement: Awaited<ReturnType<typeof start>> | undefined;
    try {
      const started = requireOwner(await start(updaterPath));
      deadOwner = started.handoffId;
      const helperStartIdentity = getFileLockProcessStartTime(started.pid);
      if (helperStartIdentity === null) {
        throw new Error("expected the detached helper to have a stable process identity");
      }
      const helper = realChild();
      leaseDatabasePath = (await readHelperParams()).updateLeaseDatabasePath;
      const readLease = () =>
        readRow(
          leaseDatabasePath!,
          "SELECT owner, payload_json FROM managed_update_handoffs WHERE install_root = ?",
          root,
        ) as { owner: string; payload_json: string } | undefined;
      const initialLease = readLease();
      expect(initialLease?.owner).toBe(started.handoffId);
      const originalPayload = updatePayload(started.pid, helperStartIdentity);
      expect(JSON.parse(initialLease?.payload_json ?? "null")).toEqual(originalPayload);

      const helperExited = once(helper, "exit");
      helper.kill("SIGKILL");
      await helperExited;
      expect(readLease()).toEqual(initialLease);

      const ownStartIdentity = getFileLockProcessStartTime(process.pid);
      if (ownStartIdentity === null || !initialLease) {
        throw new Error("expected complete live-parent and dead-helper lease identities");
      }
      const withExecutor = (change: { pid?: number; startIdentity?: string | null }) => ({
        ...originalPayload,
        executor: { ...originalPayload.executor, ...change },
      });
      const rejectedOwners = [
        ["replacement owner", "replacement-owner", originalPayload],
        [
          "different live process",
          started.handoffId,
          withExecutor({ pid: process.pid, startIdentity: String(ownStartIdentity) }),
        ],
        [
          "different recorded start identity",
          started.handoffId,
          withExecutor({ startIdentity: `${helperStartIdentity}-reused` }),
        ],
        ["malformed process identity", started.handoffId, withExecutor({ startIdentity: null })],
        [
          "noncanonical process identity",
          started.handoffId,
          { ...originalPayload, unexpected: true },
        ],
      ] as const;
      const writeLease = (owner: string, payload: unknown) => {
        if (!leaseDatabasePath) {
          throw new Error("expected the detached helper lease database path");
        }
        execute(
          leaseDatabasePath,
          "UPDATE managed_update_handoffs SET owner = ?, payload_json = ? WHERE install_root = ?",
          owner,
          JSON.stringify(payload),
          root,
        );
      };
      const identity = started;
      for (const [label, owner, payload] of rejectedOwners) {
        writeLease(owner, payload);
        await expect(cancel(identity), label).resolves.toBe(false);
        expect(readLease(), label).toEqual({
          owner,
          payload_json: JSON.stringify(payload),
        });
      }
      writeLease(started.handoffId, originalPayload);
      const kill = process.kill.bind(process);
      const unknownDeath = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === started.pid && signal === 0) {
          throw Object.assign(new Error("process visibility denied"), { code: "EPERM" });
        }
        return kill(pid, signal);
      });
      await expect(cancel(identity)).resolves.toBe(false);
      expect(readLease()).toEqual(initialLease);
      unknownDeath.mockRestore();

      await expect(cancel(identity)).resolves.toBe("restored-in-process");
      expect(readLease()).toBeUndefined();
      await expect(fs.access(markerPath)).rejects.toThrow();

      const next = requireOwner(await start(updaterPath));
      replacement = next;
      expect(next.installRoot).toBe(root);
      expect(next.handoffId).not.toBe(started.handoffId);
      await expect(cancel(next)).resolves.toBe("restored-in-process");
      replacement = undefined;
      expect(readLease()).toBeUndefined();
      await expect(fs.access(markerPath)).rejects.toThrow();
    } finally {
      if (replacement?.status === "started") {
        await cancel({ kind: "managed-update-handoff", ...replacement });
      }
      if (leaseDatabasePath && deadOwner) {
        execute(
          leaseDatabasePath,
          "DELETE FROM managed_update_handoffs WHERE install_root = ? AND owner = ?",
          root,
          deadOwner,
        );
      }
    }
  });

  it("admits another update after a transferred no-op leaves the Gateway serving", async () => {
    const { root, parent, start, transfer } = await realHandoffFixture("openclaw-handoff-noop-");
    const updaterPath = path.join(root, "updater.cjs");
    await fs.writeFile(
      updaterPath,
      `process.stdout.write(JSON.stringify({root:${JSON.stringify(root)},status:"skipped",mode:"npm",reason:"already-current"}));`,
    );
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = requireOwner(await start(updaterPath));
      expect(started.status).toBe("started");
      const child = realChild(spawnMock.mock.results.length - 1);
      const exited = new Promise<number | null>((resolve) => {
        child.once("close", resolve);
      });
      await expect(transfer(started)).resolves.toBe(true);
      expect(await exited).toBe(0);
      expect(parent).toMatchObject({ exitCode: null, signalCode: null });
    }
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("waits for the exact helper to release its lease after an immediate control-pipe EPIPE", async () => {
    const { root, start, cancel, park, readRow } = await realHandoffFixture(
      "openclaw-handoff-control-epipe-",
    );
    const identity = requireOwner(await start());
    const helper = realChild();
    const input = helper.stdin;
    if (!input) {
      throw new Error("expected the detached helper control pipe");
    }
    const { updateLeaseDatabasePath } = await readHelperParams();
    let controlDestroyed = false;
    const destroyed = vi
      .spyOn(input, "destroyed", "get")
      .mockImplementation(() => controlDestroyed);
    const write = vi.spyOn(input, "write").mockImplementation(((
      _chunk: unknown,
      callback: unknown,
    ) => {
      controlDestroyed = true;
      const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      if (typeof callback === "function") {
        callback(error);
      }
      input.emit("error", error);
      return false;
    }) as typeof input.write);

    try {
      await expect(park(identity)).resolves.toBe(false);
      expect(helper.exitCode).toBeNull();
      let cancellationSettled = false;
      const cancellation = cancel(identity).then((result) => {
        cancellationSettled = true;
        return result;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(cancellationSettled).toBe(false);
      expect(helper.exitCode).toBeNull();
      write.mockRestore();
      destroyed.mockRestore();
      input.end();

      await expect(cancellation).resolves.toBe("restored-in-process");
      expect(helper.exitCode !== null || helper.signalCode !== null).toBe(true);
      expect(
        readRow(
          updateLeaseDatabasePath,
          "SELECT owner FROM managed_update_handoffs WHERE install_root = ?",
          root,
        ),
      ).toBeUndefined();
    } finally {
      write.mockRestore();
      destroyed.mockRestore();
      input.end();
    }
  });

  it("joins canonical aliases while distinct install roots remain independent", async () => {
    const tempDir = tempRoots.make("openclaw-handoff-root-");
    const root = path.join(tempDir, "install");
    const alias = path.join(tempDir, "install-alias");
    const otherRoot = path.join(tempDir, "other");
    await fs.mkdir(root);
    await fs.mkdir(otherRoot);
    await fs.symlink(root, alias, "dir");
    const { start } = await mockHandoffFixture();

    const owner = await start({
      root,
      handoffId: "handoff-root",
    });
    await expect(start({ root: alias })).resolves.toMatchObject({
      status: "joined",
      handoffId: "handoff-root",
    });
    const other = await start({
      root: otherRoot,
      handoffId: "handoff-other",
    });

    expect(owner).toMatchObject({
      status: "started",
      handoffId: "handoff-root",
      installRoot: await fs.realpath(root),
    });
    expect(other).toMatchObject({ status: "started", handoffId: "handoff-other" });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    for (const result of spawnMock.mock.results) {
      (result.value as ReturnType<typeof createReadyChild>).emit("exit", 0, null);
    }
  });

  it.each([
    ["releases the root for another owner", false, false, false, false],
    ["retains a claimed exited owner until release is confirmed", false, false, true, false],
    ["treats control-pipe disconnect as cancellation", false, false, true, true],
    ["wins a concurrent parent exit without running the updater", true, false, false, false],
    ["refuses recovery when another owner replaces the completed helper", false, true, true, false],
  ])("cancellation %s", async (_label, exitParent, replaceOwner, claimBeforeExit, disconnect) => {
    const {
      root,
      parent,
      start: startWithPath,
      cancel,
      claim,
      readRow,
      execute,
    } = await realHandoffFixture("openclaw-cancel-owner-");
    const { getFileLockProcessStartTime } = await import("../shared/pid-alive.js");
    const replacementStartIdentity = getFileLockProcessStartTime(process.pid);
    if (replacementStartIdentity === null) {
      throw new Error("expected the replacement owner to have a stable process identity");
    }
    const { markerPath, updaterPath } = await writeMarkerUpdater(root);
    const start = () => startWithPath(updaterPath);
    const started = requireOwner(await start());
    const identity = started;
    if (claimBeforeExit) {
      expect(claim(identity)).toBe(true);
      expect(claim(identity)).toBe(true);
    }
    await expect(cancel({ ...identity, handoffId: "joined" })).resolves.toBe(false);
    const child = realChild();
    const helper = await readHelperParams();
    let joinedAfterExit: ReturnType<typeof start> | undefined;
    child.once("exit", () => {
      if (!exitParent) {
        joinedAfterExit = start();
      }
      if (replaceOwner) {
        execute(
          helper.updateLeaseDatabasePath,
          "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
          root,
          "replacement",
          JSON.stringify(updatePayload(process.pid, replacementStartIdentity)),
          Date.now(),
        );
      }
    });
    let cancellation: ReturnType<typeof cancel>;
    if (claimBeforeExit) {
      const exited = once(child, "exit");
      if (disconnect) {
        child.stdin?.end();
      } else {
        child.stdin?.write("cancel\n");
      }
      await exited;
      expect(claim(identity)).toBe(false);
      expect(joinedAfterExit).toBeDefined();
      cancellation = cancel(identity);
    } else {
      cancellation = cancel(identity);
      if (exitParent) {
        parent.stdin?.end();
      }
    }
    await expect(cancellation).resolves.toBe(replaceOwner ? false : "restored-in-process");
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    const terminal = readRow(
      helper.stateDatabasePath,
      "SELECT payload_json FROM gateway_restart_sentinel WHERE sentinel_key = 'current'",
    ) as { payload_json: string };
    expect(JSON.parse(terminal.payload_json)).toMatchObject({
      status: "skipped",
      stats: { reason: "managed-service-handoff-cancelled" },
    });
    if (joinedAfterExit) {
      await expect(joinedAfterExit).resolves.toMatchObject({
        status: "joined",
        handoffId: started.handoffId,
      });
      expect(spawnMock).toHaveBeenCalledOnce();
    }
    await expect(fs.access(markerPath)).rejects.toThrow();
    if (!replaceOwner && !exitParent) {
      execute(
        helper.stateDatabasePath,
        "DELETE FROM gateway_restart_sentinel WHERE sentinel_key = 'current'",
      );
      const next = requireOwner(await start());
      await expect(cancel(next)).resolves.toBe("restored-in-process");
    }
    if (replaceOwner) {
      execute(
        helper.updateLeaseDatabasePath,
        "DELETE FROM managed_update_handoffs WHERE install_root = ?",
        root,
      );
    }
  });
});
