import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { GatewayServiceState } from "../daemon/service-types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureEnv } from "../test-utils/env.js";

const io = vi.hoisted(() => ({
  systemdSupported: vi.fn<typeof import("@openclaw/proc-safe/systemd").isSupported>(),
  probe: vi.fn<typeof import("node:child_process").spawnSync>(),
  history: vi.fn<typeof import("./gateway-boot-lifecycle.js").readGatewayLastShutdownAsync>(),
  service: vi.fn<typeof import("../daemon/service-state.js").readGatewayServiceState>(),
  loadedJob: vi.fn<typeof import("../daemon/launchd-runtime.js").readLoadedLaunchAgentState>(),
  matchingCommand:
    vi.fn<typeof import("../daemon/launchd-runtime.js").readCorrespondingLaunchAgentCommand>(),
  restart: vi.fn<typeof import("./restart.js").requestGatewayRestartWithSignalAdmission>(),
  error: vi.fn(),
  warn: vi.fn(),
}));

// mock-isolation: Observe capability preparation without loading the host's native helper.
vi.mock("@openclaw/proc-safe/systemd", () => ({ isSupported: io.systemdSupported }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: io.probe,
}));
// mock-isolation: Keep state database readers and their child processes outside this fixture.
vi.mock("./gateway-boot-lifecycle.js", () => ({ readGatewayLastShutdownAsync: io.history }));
// mock-isolation: Native service discovery is the external observation under test.
vi.mock("../daemon/service.js", () => ({ resolveGatewayService: () => ({ label: "fixture" }) }));
// mock-isolation: Supply native manager observations without inspecting the operator's service.
vi.mock("../daemon/service-state.js", () => ({ readGatewayServiceState: io.service }));
// mock-isolation: Supply loaded and on-disk launchd observations without inspecting native jobs.
vi.mock("../daemon/launchd-runtime.js", () => ({
  readLoadedLaunchAgentState: io.loadedJob,
  readCorrespondingLaunchAgentCommand: io.matchingCommand,
}));
// mock-isolation: Observe the lifecycle request without signaling the Vitest process.
vi.mock("./restart.js", () => ({
  requestGatewayRestartWithSignalAdmission: io.restart,
  triggerOpenClawRestart: vi.fn(),
}));
// mock-isolation: The final operator log is the completion signal; no file or console output.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ error: io.error, warn: io.warn }),
}));

type RuntimeOwner = typeof import("./child-runtime-viability.js");
type RecoveryOwner = typeof import("./process-respawn.js");
type NativeWorkerRecoveryOwner = typeof import("./gateway-native-worker-recovery.js");
type RecoveryDecision = Parameters<RecoveryOwner["registerGatewayRuntimeRecovery"]>[0]["decision"];
let runtime: RuntimeOwner;
let recovery: RecoveryOwner;
let nativeWorkerRecovery: NativeWorkerRecoveryOwner;
let finished: ReturnType<typeof createDeferredCore<void>>;
let release: (() => void) | undefined;
const environment = captureEnv(["OPENCLAW_STATE_DIR", "NODE_OPTIONS"]);
const nodePath = "/fixture/current/bin/node";
const serviceEnv = { PATH: "/fixture/current/bin", NODE_OPTIONS: "--no-warnings" };
const serviceState: GatewayServiceState = {
  installed: true,
  loadState: { status: "loaded" },
  running: true,
  env: serviceEnv,
  command: {
    programArguments: [nodePath, "/fixture/openclaw.mjs", "gateway", "run"],
    workingDirectory: "/fixture/service",
    environment: serviceEnv,
  },
};
const systemd = { mode: "supervised", supervisor: "systemd" } as const;
const loadedJob = {
  ...serviceState,
  launchAgent: {
    target: "gui/501/ai.openclaw.gateway",
    sourcePath: "/fixture/Library/LaunchAgents/ai.openclaw.gateway.plist",
    program: nodePath,
    programArguments: [nodePath, "/fixture/openclaw.mjs", "gateway", "run"],
    workingDirectory: "/fixture/service",
    environment: serviceEnv,
  },
};
const probeResult = (stdout: string, stderr = "", status = 0) => ({
  pid: 123,
  output: [null, stdout, stderr],
  stdout,
  stderr,
  status,
  signal: null,
});

beforeEach(async () => {
  vi.resetModules();
  Reflect.deleteProperty(globalThis, Symbol.for("openclaw.childRuntimeViability"));
  Reflect.deleteProperty(globalThis, Symbol.for("openclaw.gatewayNativeWorkerRecovery"));
  Reflect.deleteProperty(globalThis, Symbol.for("openclaw.gatewayWorkAdmissionState"));
  vi.clearAllMocks();
  io.systemdSupported.mockReturnValue(true);
  process.env.OPENCLAW_STATE_DIR = "/fixture/runtime-recovery-state";
  process.env.NODE_OPTIONS = "--trace-warnings";
  finished = createDeferredCore();
  io.warn.mockImplementation(() => finished.resolve());
  io.history.mockResolvedValue(undefined);
  io.service.mockResolvedValue(serviceState);
  io.loadedJob.mockResolvedValue(loadedJob);
  io.matchingCommand.mockResolvedValue(serviceState.command);
  io.restart.mockReturnValue({ status: "emitted" });
  io.probe.mockReturnValue(probeResult("v24.20.0\n"));
  runtime = await import("./child-runtime-viability.js");
  nativeWorkerRecovery = await import("./gateway-native-worker-recovery.js");
  recovery = await import("./process-respawn.js");
});

afterEach(() => {
  release?.();
  release = undefined;
  environment.restore();
  Reflect.deleteProperty(globalThis, Symbol.for("openclaw.childRuntimeViability"));
  Reflect.deleteProperty(globalThis, Symbol.for("openclaw.gatewayNativeWorkerRecovery"));
  Reflect.deleteProperty(globalThis, Symbol.for("openclaw.gatewayWorkAdmissionState"));
  vi.restoreAllMocks();
});

function diagnose() {
  return runtime.classifyChildRuntimeFailure({
    stderr: "dyld[123]: Library not loaded: /fixture/retired/libnode.dylib",
  });
}

function register(
  decision: RecoveryDecision = systemd,
  ownsProcessLifecycle = true,
  isCurrent = () => true,
) {
  release = recovery.registerGatewayRuntimeRecovery({
    decision,
    ownsProcessLifecycle,
    isCurrent,
  });
}

function expectUnavailable() {
  expect(runtime.readChildRuntimeViability()).toEqual({
    execPath: process.execPath,
    available: false,
  });
}

async function recover(...args: Parameters<typeof register>) {
  register(...args);
  diagnose();
  await finished.promise;
}

function expectReported(reason: RegExp, noService = false, noProbe = false) {
  expectUnavailable();
  expect(io.restart).not.toHaveBeenCalled();
  if (noService) {
    expect(io.service).not.toHaveBeenCalled();
  }
  if (noProbe) {
    expect(io.probe).not.toHaveBeenCalled();
  }
  expect(io.warn).toHaveBeenCalledWith(expect.stringMatching(/^report-only:/));
  expect(io.warn).toHaveBeenCalledWith(expect.stringMatching(reason));
}

it.each(["systemd", "launchd"] as const)(
  "requests one graceful restart after %s Node proves viable",
  async (supervisor) => {
    register({ mode: "supervised", supervisor });
    if (supervisor === "launchd") {
      expect(io.systemdSupported).not.toHaveBeenCalled();
    }
    // The history reader must run before the first broken-runtime classification.
    await Promise.resolve();
    expect(io.history).toHaveBeenCalledOnce();
    const failure = diagnose();
    expect(failure).toMatchObject({ code: "NODE_RUNTIME_UNAVAILABLE" });
    expect(diagnose()).toBe(failure);
    expectUnavailable();
    expect(io.restart).not.toHaveBeenCalled();
    await finished.promise;
    if (supervisor === "systemd") {
      expect(io.service).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        env: process.env,
        requireEffective: true,
        requireLoadedCommand: true,
        timeoutMs: 5_000,
      });
    } else {
      expect(io.matchingCommand).toHaveBeenCalledWith(process.env, loadedJob.launchAgent, 5_000);
      expect(io.service).not.toHaveBeenCalled();
    }
    expect(io.probe).toHaveBeenCalledExactlyOnceWith(nodePath, ["--version"], {
      encoding: "utf8",
      cwd: "/fixture/service",
      env: supervisor === "systemd" ? serviceEnv : expect.objectContaining(serviceEnv),
      timeout: 1_000,
      maxBuffer: 8_192,
    });
    expect(io.restart).toHaveBeenCalledExactlyOnceWith("gateway.runtime-unavailable");
    expectUnavailable();
    expect(io.warn).toHaveBeenCalledWith(expect.stringMatching(/^restart-requested: .*graceful/));
    expect(diagnose()).toBe(failure);
    await Promise.resolve();
    expect(io.restart).toHaveBeenCalledOnce();
    expect(io.warn).toHaveBeenCalledOnce();
  },
);

it("stays up and reports the unusable service runtime without requesting restart", async () => {
  io.probe.mockReturnValueOnce(
    probeResult("", "error while loading shared libraries: libnode.so", 127),
  );
  await recover();
  expectReported(/service Node cannot start/);
});

it.each([
  ["unmanaged", { mode: "disabled", reason: "unmanaged", detail: "foreground" }, true],
  ["respawn disabled", { mode: "disabled", reason: "no-respawn" }, true],
  ["external supervisor", { mode: "supervised", supervisor: "external" }, true],
  ["embedded lifecycle", systemd, false],
] as const)("keeps %s report-only", async (_name, decision, owns) => {
  await recover(decision, owns);
  expect(io.systemdSupported).not.toHaveBeenCalled();
  expectReported(/no verified native service/, true, true);
});

it("keeps a recently restarted successor up instead of repeating runtime recovery", async () => {
  io.history.mockResolvedValueOnce({
    reason: "restart (SIGUSR2: gateway.runtime-unavailable)",
    completedAtMs: Date.now() - 60_000,
  });
  await recover();
  expectReported(/last five minutes/, true);
});

it("stays report-only when restart history is unavailable", async () => {
  io.history.mockRejectedValueOnce(new Error("fixture history unavailable"));
  await recover();
  expectReported(/history could not be read/, true);
});

it("reports an earlier diagnosis once when its history reader can no longer start", async () => {
  diagnose();
  io.history.mockRejectedValue(new Error("fixture child runtime unavailable"));
  expectUnavailable();
  register();
  await finished.promise;
  expectReported(/history could not be read/);
  release?.();
  register();
  await Promise.resolve();
  expect(io.service).not.toHaveBeenCalled();
  expect(io.restart).not.toHaveBeenCalled();
  expect(io.warn).toHaveBeenCalledOnce();
});

it("does not request restart after its lifecycle retires during preflight", async () => {
  let current = true;
  io.service.mockImplementationOnce(async () => {
    current = false;
    return serviceState;
  });
  await recover(systemd, true, () => current);
  expectReported(/already stopping/);
});

it("keeps a rewritten launchd plist report-only when it does not match the loaded job", async () => {
  io.matchingCommand.mockResolvedValueOnce(null);
  await recover({ mode: "supervised", supervisor: "launchd" });
  expect(io.loadedJob).toHaveBeenCalledOnce();
  expect(io.matchingCommand).toHaveBeenCalledOnce();
  expectReported(/no verified Node command/, true, true);
});

it("coalesces unsettled native workers into one forced fresh-process request", async () => {
  const service = createDeferredCore<GatewayServiceState>();
  io.service.mockReturnValueOnce(service.promise);
  register();
  let firstUnsettled = true;
  const first = nativeWorkerRecovery.requestGatewayNativeWorkerRecovery({
    isCurrent: () => firstUnsettled,
  });
  const second = nativeWorkerRecovery.requestGatewayNativeWorkerRecovery({ isCurrent: () => true });
  firstUnsettled = false;
  service.resolve(serviceState);
  await expect(first).resolves.toMatchObject({ status: "restart-requested" });
  await expect(second).resolves.toMatchObject({ status: "restart-requested" });
  await nativeWorkerRecovery.requestGatewayNativeWorkerRecovery({ isCurrent: () => true });
  expect(io.service).toHaveBeenCalledOnce();
  expect(io.restart).toHaveBeenCalledExactlyOnceWith("gateway.native-worker-unsettled", {
    force: true,
    waitMs: 0,
    requireFreshProcess: true,
  });
  expect(runtime.readChildRuntimeViability().available).toBe(true);
});

it("prepares native systemd inspection before a worker can require recovery", async () => {
  register();
  expect(io.systemdSupported).toHaveBeenCalledOnce();
  expect(io.service).not.toHaveBeenCalled();
  io.systemdSupported.mockImplementation(() => {
    throw new Error("late native initialization would wait for the unsettled worker");
  });
  await expect(
    nativeWorkerRecovery.requestGatewayNativeWorkerRecovery({ isCurrent: () => true }),
  ).resolves.toMatchObject({ status: "restart-requested" });
  expect(io.systemdSupported).toHaveBeenCalledOnce();
  expect(io.service).toHaveBeenCalledOnce();
});

it("keeps recovery report-only when native systemd inspection was unavailable at startup", async () => {
  io.systemdSupported.mockReturnValueOnce(false);
  register();
  await expect(
    nativeWorkerRecovery.requestGatewayNativeWorkerRecovery({ isCurrent: () => true }),
  ).resolves.toMatchObject({
    status: "report-only",
    reason: expect.stringContaining("native systemd inspection was unavailable at Gateway startup"),
  });
  expect(io.systemdSupported).toHaveBeenCalledOnce();
  expect(io.service).not.toHaveBeenCalled();
  expect(io.probe).not.toHaveBeenCalled();
  expect(io.restart).not.toHaveBeenCalled();
});

it("does not restart for a native worker that settles during service verification", async () => {
  let unsettled = true;
  io.service.mockImplementationOnce(async () => {
    unsettled = false;
    return serviceState;
  });
  register();
  await expect(
    nativeWorkerRecovery.requestGatewayNativeWorkerRecovery({ isCurrent: () => unsettled }),
  ).resolves.toMatchObject({ status: "report-only", reason: expect.stringContaining("settled") });
  expect(io.restart).not.toHaveBeenCalled();
  // A later distinct worker can still request recovery in this lifecycle.
  await expect(
    nativeWorkerRecovery.requestGatewayNativeWorkerRecovery({ isCurrent: () => true }),
  ).resolves.toMatchObject({ status: "restart-requested" });
});

it("refuses native recovery after the registering lifecycle retires during verification", async () => {
  io.service.mockImplementationOnce(async () => {
    release?.();
    return serviceState;
  });
  register();
  await expect(
    nativeWorkerRecovery.requestGatewayNativeWorkerRecovery({ isCurrent: () => true }),
  ).resolves.toMatchObject({ status: "report-only", reason: expect.stringContaining("stopping") });
  await expect(
    nativeWorkerRecovery.requestGatewayNativeWorkerRecovery({ isCurrent: () => true }),
  ).resolves.toMatchObject({
    status: "report-only",
    reason: expect.stringContaining("no Gateway"),
  });
  expect(io.restart).not.toHaveBeenCalled();
});

it.each([
  ["unmanaged", { mode: "disabled", reason: "unmanaged", detail: "foreground" }, true],
  ["respawn disabled", { mode: "disabled", reason: "no-respawn" }, true],
  ["external supervisor", { mode: "supervised", supervisor: "external" }, true],
  ["embedded lifecycle", systemd, false],
] as const)("refuses automatic native-worker recovery for %s", async (_name, decision, owns) => {
  register(decision, owns);
  expect(io.systemdSupported).not.toHaveBeenCalled();
  await expect(
    nativeWorkerRecovery.requestGatewayNativeWorkerRecovery({ isCurrent: () => true }),
  ).resolves.toMatchObject({
    status: "report-only",
    reason: expect.stringContaining("no verified native service"),
  });
  expect(io.service).not.toHaveBeenCalled();
  expect(io.restart).not.toHaveBeenCalled();
});

it("does not claim an unrelated coalesced restart acquired fresh-process authority", async () => {
  io.restart.mockReturnValueOnce({ status: "coalesced" });
  register();
  await expect(
    nativeWorkerRecovery.requestGatewayNativeWorkerRecovery({ isCurrent: () => true }),
  ).resolves.toMatchObject({ status: "report-only", reason: expect.stringContaining("coalesced") });
});

it("reports a failed native service probe instead of rejecting the worker's cleanup", async () => {
  io.service.mockRejectedValueOnce(new Error("fixture service unavailable"));
  register();
  await expect(
    nativeWorkerRecovery.requestGatewayNativeWorkerRecovery({ isCurrent: () => true }),
  ).resolves.toMatchObject({
    status: "report-only",
    reason: expect.stringContaining("preparation failed"),
  });
  expect(io.restart).not.toHaveBeenCalled();
});
