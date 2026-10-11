import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { MANAGED_HANDOFF_COMMAND_SOURCE } from "./update-managed-service-handoff-command-source.js";
import { HANDOFF_OWNED_COMMAND_SCRIPT } from "./update-managed-service-handoff-control.js";
import { MANAGED_HANDOFF_LEASE_SOURCE } from "./update-managed-service-handoff-lease-source.js";
import { MANAGED_HANDOFF_NATIVE_SCOPE_SOURCE } from "./update-managed-service-handoff-native-scope-source.js";
import { MANAGED_HANDOFF_RESULT_SOURCE } from "./update-managed-service-handoff-result-source.js";

const helperSource = readFileSync(
  new URL("./update-managed-service-handoff.ts", import.meta.url),
  "utf8",
);
function sourceBetween(start: string, end: string) {
  const from = helperSource.indexOf(start);
  const to = helperSource.indexOf(end, from);
  if (from < 0 || to < 0) {
    throw new Error("Managed handoff source boundary changed");
  }
  return helperSource.slice(from, to);
}

// Render the shipped signal/transfer, command-result and finally blocks together.
// Native processes and ledger I/O are deferred fixtures; no helper boot, real signal,
// service, database, or compiled worker is needed for these ownership transitions.
const lifecycleSource: string = runInNewContext(
  "String.raw`" +
    sourceBetween("let managedUpdateLease = null;", "function sleep(ms)") +
    sourceBetween('process.on("SIGTERM",', "function isLaunchdNotLoaded") +
    "`",
  { MANAGED_HANDOFF_LEASE_SOURCE, UPDATE_RUN_ID_ENV: "OPENCLAW_UPDATE_RUN_ID" },
);
const finalizerSource = sourceBetween(
  "  } finally {\n    clearTimeout(parentExitDeadline);",
  "\n})().catch((err) =>",
).replace(
  "${JSON.stringify(SYSTEM_SERVICE_UPDATE_SETTLED_MARKER)}",
  JSON.stringify("system-update-settled\n"),
);
const commandResultSource = sourceBetween(
  "    const exit = await runOwnedUpdateCommand(params.action,",
  "    automaticRequested = Boolean(exit.continuation);",
);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function createBoundary(action: "update" | "triage" = "update") {
  const serviceSpawned = createDeferred();
  const commandAdmitted = createDeferred();
  const terminalStarted = createDeferred();
  const terminalFinished = createDeferred();
  const order: string[] = [];
  const stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    destroy: vi.fn((): void => {
      stdin.destroyed = true;
    }),
  });
  const processResult: { exitCode?: number } = {};
  const processFixture = Object.assign(new EventEmitter(), processResult, {
    pid: 100,
    platform: "linux",
    execPath: "/fixture/node",
    argv: ["/fixture/node", "/fixture/helper.cjs", "/fixture/params.json"],
    env: { OPENCLAW_UPDATE_RUN_ID: "fixture-run" },
    stdin,
    execve: vi.fn(),
  });
  const params = {
    action,
    cwd: "/fixture",
    invocationCwd: "/fixture",
    logPath: "/fixture/helper.log",
    runId: "fixture-run",
    recoveryTimeoutMs: 60_000,
    recoveryModulePath: "/fixture/install/dist/cli/daemon-cli.js",
    serviceRecovery: { kind: "systemd", unit: "openclaw-gateway.service" },
    scopeUnit: "openclaw-update-fixture.scope",
    updateLeaseKey: "/fixture/install",
    systemdRun: "/fixture/systemd-run",
    runtimeArgs: [],
    commandArgv: ["/fixture/node", "/fixture/cli.mjs", "triage"],
    sensitivePaths: ["/fixture/params.json"],
  };
  const lease = {
    key: params.updateLeaseKey,
    executor: { pid: processFixture.pid },
    helper: { pid: processFixture.pid },
    action: { kind: action },
    payload: "fixture-helper",
  };
  const authority = { current: true };
  const leaseStore = {
    owns: vi.fn(() => authority.current),
    bind: vi.fn((_lease: typeof lease, pid: number) => ({ ...lease, executor: { pid } })),
    retarget: vi.fn((_lease: typeof lease, key: string, nextAction: typeof lease.action) => ({
      kind: "acquired",
      lease: { ...lease, key, action: nextAction },
    })),
    release: vi.fn(() => {
      order.push("release");
      return authority.current;
    }),
    settle: vi.fn(),
    stopNative: vi.fn(),
  };
  const logs: string[] = [];
  const fs = {
    writeFileSync: vi.fn<(filePath: string, contents: string, options: unknown) => void>(),
    openSync: vi.fn(() => 9),
    closeSync: vi.fn(),
    rmSync: vi.fn(() => order.push("cleanup")),
  };
  const service = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: false,
  });
  const gate = Object.assign(new EventEmitter(), {
    end: (_data: string, callback: () => void): void => {
      callback();
      commandAdmitted.resolve();
      if (action === "update") {
        order.push("terminal:start");
        terminalStarted.resolve();
        void terminalFinished.promise.then(() => {
          order.push("terminal:done");
          command.exitCode = 0;
          command.emit("exit", 0, null);
          command.emit("close", 0, null);
        });
      }
    },
  });
  const commandResult: { exitCode: number | null; signalCode: NodeJS.Signals | null } = {
    exitCode: null,
    signalCode: null,
  };
  const command = Object.assign(new EventEmitter(), commandResult, {
    pid: 101,
    spawnargs: params.commandArgv,
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    stdout: new EventEmitter(),
    stdio: [null, null, null, null, gate],
    kill: vi.fn(),
  });
  const spawn = vi.fn((executable: string) => {
    if (executable === "systemctl") {
      serviceSpawned.resolve();
      void Promise.resolve().then(() => service.emit("spawn"));
      return service;
    }
    void Promise.resolve().then(() => command.emit("spawn"));
    return command;
  });
  const boundary: {
    transfer: (continuation: unknown) => Promise<void>;
    command: () => Promise<void>;
  } = runInNewContext(
    `
    let restorationArmed = true;
    let parkedServiceFragment = "/fixture/gateway.service";
    let foregroundParked = false, foregroundClosed = false, foregroundRespawn = false;
    let updaterStarted = true, automaticRequested = true;
    let finishBeforeParkNotice, parentExitDeadline;
    ${lifecycleSource}
    ${MANAGED_HANDOFF_RESULT_SOURCE}
    ${MANAGED_HANDOFF_COMMAND_SOURCE}
    ${MANAGED_HANDOFF_NATIVE_SCOPE_SOURCE}
    ${HANDOFF_OWNED_COMMAND_SCRIPT}
    ${sourceBetween("function cleanupSensitiveFiles()", "function assertStateDatabaseWriteAllowed")}
    managedUpdateLease = initialLease;
    if (params.action === "update") {
      runLedger = {};
      runOutcome = { status: "failed", reason: "candidate-validation-failed" };
    }
    async function complete(operation) {
      try { await operation();
      ${finalizerSource}
    }
    ({
      transfer: (continuation) => complete(() => enterTriageAfterUpdate(continuation)),
      command: () => complete(async () => { ${commandResultSource} }),
    });
    `,
    {
      params,
      process: processFixture,
      fs,
      leaseStore,
      initialLease: lease,
      spawn,
      path,
      runWarnings: new Map(),
      Buffer,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      appendLog: (line: string) => logs.push(line),
      parseSystemdProperties: (stdout: string) =>
        Object.fromEntries(stdout.split("\n").map((line) => line.split("="))),
    },
  );
  const inspect = () => {
    service.stdout.emit(
      "data",
      "Id=openclaw-gateway.service\nLoadState=loaded\nFragmentPath=/fixture/gateway.service",
    );
    service.emit("close", 0);
  };
  const continuation = {
    failure: { installationRoot: "/fixture/installed" },
    commandArgv: params.commandArgv,
  };
  return {
    ...boundary,
    continuation,
    inspect,
    serviceSpawned,
    commandAdmitted,
    terminalStarted,
    terminalFinished,
    order,
    logs,
    fs,
    lease,
    leaseStore,
    authority,
    process: processFixture,
    child: command,
  };
}

it.each(["inspection", "finalization"] as const)(
  "joins normal settlement instead of transferring triage after SIGTERM during %s",
  async (stage) => {
    const fixture = createBoundary();
    const completed = fixture.transfer(fixture.continuation);
    await awaitGateBeforeSettlement(
      fixture.serviceSpawned.promise,
      completed,
      "inspection not reached",
    );
    if (stage === "inspection") {
      fixture.process.emit("SIGTERM");
    }
    fixture.inspect();
    await awaitGateBeforeSettlement(
      fixture.terminalStarted.promise,
      completed,
      "finalization not reached",
    );
    if (stage === "finalization") {
      fixture.process.emit("SIGTERM");
      expect(fixture.child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    }
    expect(fixture.leaseStore.retarget).not.toHaveBeenCalled();
    expect(fixture.leaseStore.release).not.toHaveBeenCalled();
    expect(fixture.fs.rmSync).not.toHaveBeenCalled();
    expect(fixture.process.exitCode).toBeUndefined();
    fixture.terminalFinished.resolve();
    await completed;
    expect(fixture.leaseStore.retarget).not.toHaveBeenCalled();
    expect(fixture.process.execve).not.toHaveBeenCalled();
    expect(fixture.leaseStore.release).toHaveBeenCalledExactlyOnceWith(fixture.lease);
    expect(fixture.order).toEqual(["terminal:start", "terminal:done", "release", "cleanup"]);
    expect(fixture.logs).toContain("managed update helper completed code=143");
    expect(fixture.process.exitCode).toBe(143);
    expect(fixture.process.stdin.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([true, false])(
  "revalidates live lease authority after finalization (current=%s)",
  async (current) => {
    const fixture = createBoundary();
    const completed = fixture.transfer(fixture.continuation);
    await awaitGateBeforeSettlement(
      fixture.serviceSpawned.promise,
      completed,
      "inspection not reached",
    );
    fixture.inspect();
    await awaitGateBeforeSettlement(
      fixture.terminalStarted.promise,
      completed,
      "finalization not reached",
    );
    fixture.authority.current = current;
    fixture.terminalFinished.resolve();
    await completed;
    if (current) {
      expect(fixture.leaseStore.retarget).toHaveBeenCalledExactlyOnceWith(
        fixture.lease,
        "/fixture/installed",
        expect.objectContaining({ kind: "triage", phase: "reserved" }),
      );
      expect(fixture.process.execve).toHaveBeenCalledExactlyOnceWith(
        "/fixture/systemd-run",
        expect.arrayContaining(["--unit=openclaw-triage-fixture.scope"]),
        {},
      );
    } else {
      expect(fixture.leaseStore.retarget).not.toHaveBeenCalled();
      expect(fixture.process.execve).not.toHaveBeenCalled();
    }
  },
);

it("revalidates the retargeted lease immediately before execve", async () => {
  const fixture = createBoundary();
  fixture.fs.writeFileSync.mockImplementation((filePath) => {
    if (filePath === "/fixture/params.json") {
      fixture.authority.current = false;
    }
  });
  const completed = fixture.transfer(fixture.continuation);
  await awaitGateBeforeSettlement(
    fixture.serviceSpawned.promise,
    completed,
    "inspection not reached",
  );
  fixture.inspect();
  await awaitGateBeforeSettlement(
    fixture.terminalStarted.promise,
    completed,
    "finalization not reached",
  );
  fixture.terminalFinished.resolve();
  await completed;
  expect(fixture.leaseStore.retarget).toHaveBeenCalledTimes(1);
  expect(fixture.fs.writeFileSync).toHaveBeenCalledWith(
    "/fixture/params.json",
    expect.any(String),
    {
      mode: 0o600,
    },
  );
  expect(fixture.process.execve).not.toHaveBeenCalled();
  expect(fixture.process.stdin.destroyed).toBe(true);
});

it.each([0, 7])(
  "preserves failed admission through outer finalization when triage exits %s",
  async (code) => {
    const fixture = createBoundary("triage");
    const completed = fixture.command();
    await awaitGateBeforeSettlement(
      fixture.commandAdmitted.promise,
      completed,
      "command not admitted",
    );
    fixture.child.exitCode = code;
    fixture.child.emit("exit", code, null);
    fixture.child.emit("close", code, null);
    await completed;
    expect(fixture.logs).toContain(
      "The installed update does not support automatic diagnostics. Run openclaw triage manually.",
    );
    expect(fixture.logs).toContain("managed update helper completed code=" + (code || 1));
    expect(fixture.process.exitCode).toBe(code || 1);
    expect(fixture.process.stdin.destroyed).toBe(true);
    expect(fixture.fs.closeSync).toHaveBeenCalledWith(9);
    expect(fixture.fs.rmSync).toHaveBeenCalledWith("/fixture/params.json", { force: true });
    expect(vi.getTimerCount()).toBe(0);
  },
);
