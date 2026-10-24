import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
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

// Execute the shipped settlement, diagnostics and finally blocks with deferred
// native I/O so cancellation and lease ownership stay observable without a boot.
const lifecycleSource: string = runInNewContext(
  "String.raw`" +
    sourceBetween("let managedUpdateLease = null;", "function sleep(ms)") +
    sourceBetween('process.on("SIGTERM",', "function isLaunchdNotLoaded") +
    "`",
  { MANAGED_HANDOFF_LEASE_SOURCE },
);
const finalizerSource = sourceBetween(
  "  } finally {\n    try { await finishManagedUpdateRun(); }",
  "\n})().catch((err) =>",
).replace(
  "${JSON.stringify(SYSTEM_SERVICE_UPDATE_SETTLED_MARKER)}",
  JSON.stringify("system-update-settled\n"),
);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function createBoundary(action: "update" | "triage" = "update") {
  const terminalStarted = createDeferred();
  const terminalFinished = createDeferred();
  const diagnosticStarted = createDeferred();
  const diagnosticFinished = createDeferred();
  const commandAdmitted = createDeferred();
  const order: string[] = [];
  const processFixture = Object.assign(new EventEmitter(), {
    pid: 100,
    platform: "linux",
    execPath: "/fixture/node",
    env: {},
    stdin: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    exitCode: undefined as number | undefined,
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
    runtimeArgs: [],
    nodeExecArgv: [],
    commandArgv: ["/fixture/node", "/fixture/cli.mjs", "triage"],
    triageCommandArgv: ["/fixture/node", "/fixture/cli.mjs", "triage", "--non-interactive"],
    triageInputPath: "/fixture/diagnostics.json",
    triageContextPath: "/fixture/failure.json",
    triageContextCommand: "openclaw triage --run --update-result /fixture/failure.json",
    sensitivePaths: ["/fixture/params.json", "/fixture/diagnostics.json"],
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
    bind: vi.fn((currentLease: typeof lease, pid: number) =>
      authority.current ? { ...currentLease, executor: { pid } } : false,
    ),
    isProcessIdentityCurrent: vi.fn(() => authority.current),
    retarget: vi.fn(),
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
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => JSON.stringify({ error: "candidate-validation-failed" })),
    openSync: vi.fn(() => 9),
    closeSync: vi.fn(),
    rmSync: vi.fn(() => order.push("cleanup")),
  };
  const children: ReturnType<typeof makeCommand>[] = [];
  function makeCommand(diagnostic: boolean) {
    const child = Object.assign(new EventEmitter(), {
      pid: 101,
      spawnargs: params.commandArgv,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      stdout: new EventEmitter(),
      stdio: [] as EventEmitter[],
      kill: vi.fn((signal: NodeJS.Signals) => {
        void Promise.resolve().then(() => {
          child.signalCode = signal;
          child.emit("exit", null, signal);
          child.emit("close", null, signal);
        });
      }),
    });
    const gate = Object.assign(new EventEmitter(), {
      end: (_data: string, callback: () => void) => {
        callback();
        if (action === "triage") {
          commandAdmitted.resolve();
          return;
        }
        const phase = diagnostic ? "diagnostic" : "terminal";
        order.push(phase + ":start");
        (diagnostic ? diagnosticStarted : terminalStarted).resolve();
        void (diagnostic ? diagnosticFinished : terminalFinished).promise.then(() => {
          order.push(phase + ":done");
          child.exitCode = 0;
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
      },
    });
    child.stdio = [...Array.from({ length: 4 }, () => new EventEmitter()), gate];
    return child;
  }
  const spawn = vi.fn((_executable: string, args: string[]) => {
    const child = makeCommand(args.includes("triage"));
    children.push(child);
    void Promise.resolve().then(() => child.emit("spawn"));
    return child;
  });
  const boundary: { settle: () => Promise<void>; command: () => Promise<void> } = runInNewContext(
    `
    let restorationArmed = true;
    let foregroundParked = false, foregroundClosed = false, foregroundRespawn = false;
    let updaterStarted = true;
    let finishBeforeParkNotice;
    ${lifecycleSource}
    ${MANAGED_HANDOFF_RESULT_SOURCE}
    ${MANAGED_HANDOFF_NATIVE_SCOPE_SOURCE}
    ${HANDOFF_OWNED_COMMAND_SCRIPT}
    ${sourceBetween("async function collectUpdateFailureTriage()", "\n(async () => {")}
    ${sourceBetween("function cleanupSensitiveFiles()", "${MANAGED_HANDOFF_SQLITE_SOURCE}")}
    managedUpdateLease = initialLease;
    if (params.action === "update") {
      runLedger = {};
      runOutcome = { status: "failed", reason: "candidate-validation-failed" };
      triageFailure = { reason: "candidate-validation-failed" };
      finalExitCode = 1;
    }
    async function complete(operation) {
      try { await operation();
      ${finalizerSource}
    }
    ({ settle: () => complete(async () => {}),
      command: () => complete(async () => { ${sourceBetween("    const exit = await runOwnedUpdateCommand(params.action,", "    if (updateCancelled || activationRejected)")} }), });
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
      killOwnedCommand: (child: ReturnType<typeof makeCommand>) => child.kill("SIGKILL"),
    },
  );
  return {
    ...boundary,
    terminalStarted,
    terminalFinished,
    diagnosticStarted,
    diagnosticFinished,
    commandAdmitted,
    children,
    spawn,
    order,
    logs,
    fs,
    lease,
    leaseStore,
    authority,
    process: processFixture,
  };
}

async function startSettlement(fixture = createBoundary()) {
  const completed = fixture.settle();
  await awaitGateBeforeSettlement(
    fixture.terminalStarted.promise,
    completed,
    "finalization not reached",
  );
  return { fixture, completed };
}

function expectNoReplacement(fixture: ReturnType<typeof createBoundary>) {
  expect(fixture.leaseStore.retarget).not.toHaveBeenCalled();
  expect(fixture.process.execve).not.toHaveBeenCalled();
}

it.each(["finalization", "diagnostics"] as const)(
  "joins settlement before cleanup after SIGTERM during %s",
  async (stage) => {
    const { fixture, completed } = await startSettlement();
    if (stage === "diagnostics") {
      fixture.terminalFinished.resolve();
      await awaitGateBeforeSettlement(
        fixture.diagnosticStarted.promise,
        completed,
        "diagnostics not reached",
      );
    }
    fixture.process.emit("SIGTERM");
    expect(fixture.children.at(-1)?.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(fixture.leaseStore.release).not.toHaveBeenCalled();
    expect(fixture.fs.rmSync).not.toHaveBeenCalled();
    expect(fixture.process.exitCode).toBeUndefined();
    fixture.terminalFinished.resolve();
    fixture.diagnosticFinished.resolve();
    await completed;
    expectNoReplacement(fixture);
    expect(fixture.leaseStore.release).toHaveBeenCalledExactlyOnceWith(fixture.lease);
    expect(fixture.order).toEqual([
      "terminal:start",
      "terminal:done",
      ...(stage === "diagnostics" ? ["diagnostic:start", "diagnostic:done"] : []),
      "release",
      "cleanup",
      "cleanup",
    ]);
    expect(fixture.logs).toContain("managed update helper completed code=143");
    expect(fixture.process.exitCode).toBe(143);
    expect(fixture.process.stdin.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["current", "lost-before-diagnostics", "lost-before-admission"] as const)(
  "revalidates diagnostic lease authority: %s",
  async (authority) => {
    const fixture = createBoundary();
    const lateRevocation = authority === "lost-before-admission";
    if (lateRevocation) {
      fixture.fs.writeFileSync.mockImplementation((filePath) => {
        if (filePath === "/fixture/diagnostics.json") {
          fixture.authority.current = false;
        }
      });
    }
    const { completed } = await startSettlement(fixture);
    const current = authority !== "lost-before-diagnostics";
    fixture.authority.current = current;
    fixture.terminalFinished.resolve();
    fixture.diagnosticFinished.resolve();
    await completed;
    expect(fixture.spawn).toHaveBeenCalledTimes(current ? 2 : 1);
    expect(
      fixture.fs.writeFileSync.mock.calls.some(([file]) => file === "/fixture/diagnostics.json"),
    ).toBe(current);
    if (lateRevocation) {
      expect(fixture.children[1]?.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(fixture.order).not.toContain("diagnostic:start");
      expect(fixture.process.stdin.destroy).toHaveBeenCalledOnce();
    } else if (current) {
      expect(fixture.spawn.mock.calls[1]?.[1]).toEqual(
        expect.arrayContaining([
          "triage",
          "--non-interactive",
          "--update-result",
          "/fixture/diagnostics.json",
        ]),
      );
      expect(fixture.logs).toContain(
        "Reuse this diagnostic context on the Gateway host: openclaw triage --run --update-result /fixture/failure.json",
      );
    }
    expectNoReplacement(fixture);
    expect(fixture.process.exitCode).toBe(1);
  },
);

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
    const child = fixture.children[0]!;
    child.exitCode = code;
    child.emit("exit", code, null);
    child.emit("close", code, null);
    await completed;
    expect(fixture.logs).toContain(
      "The installed update does not support automatic diagnostics. Run openclaw triage manually.",
    );
    expect(fixture.logs).toContain("managed update helper completed code=" + (code || 1));
    expect(fixture.process.exitCode).toBe(code || 1);
    expect(fixture.process.stdin.destroy).toHaveBeenCalledOnce();
    expect(fixture.fs.closeSync).toHaveBeenCalledWith(9);
    expect(fixture.fs.rmSync).toHaveBeenCalledWith("/fixture/params.json", { force: true });
    expect(vi.getTimerCount()).toBe(0);
  },
);
