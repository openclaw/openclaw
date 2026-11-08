import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { GatewayServiceState } from "../daemon/service-types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureEnv } from "../test-utils/env.js";

const io = vi.hoisted(() => ({
  probe: vi.fn<typeof import("node:child_process").spawnSync>(),
  history: vi.fn<typeof import("./gateway-boot-lifecycle.js").readGatewayLastShutdownAsync>(),
  service: vi.fn<typeof import("../daemon/service-state.js").readGatewayServiceState>(),
  loadedLaunchAgent:
    vi.fn<typeof import("../daemon/launchd-runtime.js").readLoadedLaunchAgentState>(),
  correspondingLaunchAgent:
    vi.fn<typeof import("../daemon/launchd-runtime.js").readCorrespondingLaunchAgentCommand>(),
  restart: vi.fn<typeof import("./restart.js").requestGatewayRestartWithSignalAdmission>(),
  error: vi.fn(),
  warn: vi.fn(),
}));

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
  readLoadedLaunchAgentState: io.loadedLaunchAgent,
  readCorrespondingLaunchAgentCommand: io.correspondingLaunchAgent,
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
let runtime: RuntimeOwner;
let recovery: RecoveryOwner;
let finished: ReturnType<typeof createDeferredCore<void>>;
let release: (() => void) | undefined;
const environment = captureEnv(["OPENCLAW_STATE_DIR", "NODE_OPTIONS"]);
const serviceRuntime = "/fixture/current/bin/node";
const serviceEnvironment = { PATH: "/fixture/current/bin", NODE_OPTIONS: "--no-warnings" };
const serviceState: GatewayServiceState = {
  installed: true,
  loadState: { status: "loaded" },
  running: true,
  env: serviceEnvironment,
  command: {
    programArguments: [serviceRuntime, "/fixture/openclaw.mjs", "gateway", "run"],
    workingDirectory: "/fixture/service",
    environment: serviceEnvironment,
  },
};
const runningUnderService = { mode: "supervised", supervisor: "systemd" } as const;
const loadedLaunchAgent = {
  ...serviceState,
  launchAgent: {
    target: "gui/501/ai.openclaw.gateway",
    sourcePath: "/fixture/Library/LaunchAgents/ai.openclaw.gateway.plist",
    program: serviceRuntime,
    programArguments: [serviceRuntime, "/fixture/openclaw.mjs", "gateway", "run"],
    workingDirectory: "/fixture/service",
    environment: serviceEnvironment,
  },
};

beforeEach(async () => {
  vi.resetModules();
  Reflect.deleteProperty(globalThis, Symbol.for("openclaw.childRuntimeViability"));
  Reflect.deleteProperty(globalThis, Symbol.for("openclaw.gatewayWorkAdmissionState"));
  vi.clearAllMocks();
  process.env.OPENCLAW_STATE_DIR = "/fixture/runtime-recovery-state";
  process.env.NODE_OPTIONS = "--trace-warnings";
  finished = createDeferredCore();
  io.warn.mockImplementation(() => finished.resolve());
  io.history.mockResolvedValue(undefined);
  io.service.mockResolvedValue(serviceState);
  io.loadedLaunchAgent.mockResolvedValue(loadedLaunchAgent);
  io.correspondingLaunchAgent.mockResolvedValue(serviceState.command);
  io.restart.mockReturnValue({ status: "emitted" });
  io.probe.mockReturnValue({
    pid: 123,
    output: [null, "v24.20.0\n", ""],
    stdout: "v24.20.0\n",
    stderr: "",
    status: 0,
    signal: null,
  });
  runtime = await import("./child-runtime-viability.js");
  recovery = await import("./process-respawn.js");
});

afterEach(() => {
  release?.();
  release = undefined;
  environment.restore();
  Reflect.deleteProperty(globalThis, Symbol.for("openclaw.childRuntimeViability"));
  Reflect.deleteProperty(globalThis, Symbol.for("openclaw.gatewayWorkAdmissionState"));
  vi.restoreAllMocks();
});

function diagnose() {
  return runtime.classifyChildRuntimeFailure({
    stderr: "dyld[123]: Library not loaded: /fixture/retired/libnode.dylib",
  });
}

function register(
  decision: Parameters<
    RecoveryOwner["registerGatewayRuntimeRecovery"]
  >[0]["decision"] = runningUnderService,
  ownsProcessLifecycle = true,
) {
  release = recovery.registerGatewayRuntimeRecovery({
    decision,
    ownsProcessLifecycle,
    isCurrent: () => true,
  });
}

function expectReported(reason: RegExp) {
  expect(runtime.readChildRuntimeViability()).toEqual({
    execPath: process.execPath,
    available: false,
  });
  expect(io.warn).toHaveBeenCalledWith(expect.stringMatching(/^report-only:/));
  expect(io.warn).toHaveBeenCalledWith(expect.stringMatching(reason));
}

it("requests one graceful lifecycle restart after the service's Node proves it can start", async () => {
  register();
  // The history reader must run before the first broken-runtime classification.
  await Promise.resolve();
  expect(io.history).toHaveBeenCalledOnce();
  const failure = diagnose();
  expect(failure).toMatchObject({ code: "NODE_RUNTIME_UNAVAILABLE" });
  expect(diagnose()).toBe(failure);
  expect(runtime.readChildRuntimeViability()).toEqual({
    execPath: process.execPath,
    available: false,
  });
  expect(io.restart).not.toHaveBeenCalled();
  await finished.promise;
  expect(io.service).toHaveBeenCalledOnce();
  expect(io.service).toHaveBeenCalledWith(expect.anything(), {
    env: process.env,
    requireEffective: true,
    requireLoadedCommand: true,
    timeoutMs: 5_000,
  });
  expect(io.probe).toHaveBeenCalledExactlyOnceWith(serviceRuntime, ["--version"], {
    encoding: "utf8",
    cwd: "/fixture/service",
    env: serviceEnvironment,
    timeout: 1_000,
    maxBuffer: 8_192,
  });
  expect(io.restart).toHaveBeenCalledExactlyOnceWith("gateway.runtime-unavailable");
  expect(runtime.readChildRuntimeViability()).toEqual({
    execPath: process.execPath,
    available: false,
  });
  expect(io.warn).toHaveBeenCalledWith(expect.stringMatching(/^restart-requested: .*graceful/));
  expect(diagnose()).toBe(failure);
  await Promise.resolve();
  expect(io.restart).toHaveBeenCalledOnce();
  expect(io.warn).toHaveBeenCalledOnce();
});

it("stays up and reports the unusable service runtime without requesting restart", async () => {
  io.probe.mockReturnValueOnce({
    pid: 0,
    output: [null, "", "error while loading shared libraries: libnode.so"],
    stdout: "",
    stderr: "error while loading shared libraries: libnode.so",
    status: 127,
    signal: null,
  });
  register();
  diagnose();
  await finished.promise;
  expect(io.restart).not.toHaveBeenCalled();
  expectReported(/service Node cannot start/);
});

it.each([
  {
    name: "unmanaged",
    decision: { mode: "disabled", reason: "unmanaged", detail: "foreground" },
    owns: true,
  },
  { name: "respawn disabled", decision: { mode: "disabled", reason: "no-respawn" }, owns: true },
  {
    name: "external supervisor without a known command",
    decision: { mode: "supervised", supervisor: "external" },
    owns: true,
  },
  { name: "embedded lifecycle", decision: runningUnderService, owns: false },
] as const)("keeps $name report-only", async ({ decision, owns }) => {
  register(decision, owns);
  diagnose();
  await finished.promise;
  expect(io.service).not.toHaveBeenCalled();
  expect(io.probe).not.toHaveBeenCalled();
  expect(io.restart).not.toHaveBeenCalled();
  expectReported(/no verified native service/);
});

it("keeps a recently restarted successor up instead of repeating runtime recovery", async () => {
  io.history.mockResolvedValueOnce({
    reason: "restart (SIGUSR2: gateway.runtime-unavailable)",
    completedAtMs: Date.now() - 60_000,
  });
  register();
  diagnose();
  await finished.promise;
  expect(io.service).not.toHaveBeenCalled();
  expect(io.restart).not.toHaveBeenCalled();
  expectReported(/last five minutes/);
});

it("stays report-only when restart history is unavailable", async () => {
  io.history.mockRejectedValueOnce(new Error("fixture history unavailable"));
  register();
  diagnose();
  await finished.promise;
  expect(io.service).not.toHaveBeenCalled();
  expect(io.restart).not.toHaveBeenCalled();
  expectReported(/history could not be read/);
});

it("reports an earlier diagnosis once when its history reader can no longer start", async () => {
  diagnose();
  io.history.mockRejectedValue(new Error("fixture child runtime unavailable"));
  expect(runtime.readChildRuntimeViability()).toEqual({
    execPath: process.execPath,
    available: false,
  });
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
  release = recovery.registerGatewayRuntimeRecovery({
    decision: runningUnderService,
    ownsProcessLifecycle: true,
    isCurrent: () => current,
  });
  diagnose();
  await finished.promise;
  expect(io.restart).not.toHaveBeenCalled();
  expectReported(/already stopping/);
});

it("keeps a rewritten launchd plist report-only when it does not match the loaded job", async () => {
  io.correspondingLaunchAgent.mockResolvedValueOnce(null);
  register({ mode: "supervised", supervisor: "launchd" });
  diagnose();
  await finished.promise;
  expect(io.loadedLaunchAgent).toHaveBeenCalledOnce();
  expect(io.correspondingLaunchAgent).toHaveBeenCalledOnce();
  expect(io.service).not.toHaveBeenCalled();
  expect(io.probe).not.toHaveBeenCalled();
  expect(io.restart).not.toHaveBeenCalled();
  expectReported(/no verified Node command/);
});

it("requests restart after the loaded launchd job matches its viable on-disk command", async () => {
  register({ mode: "supervised", supervisor: "launchd" });
  diagnose();
  await finished.promise;
  expect(io.correspondingLaunchAgent).toHaveBeenCalledWith(
    process.env,
    loadedLaunchAgent.launchAgent,
    5_000,
  );
  expect(io.service).not.toHaveBeenCalled();
  expect(io.probe).toHaveBeenCalledWith(
    serviceRuntime,
    ["--version"],
    expect.objectContaining({
      cwd: "/fixture/service",
      env: expect.objectContaining(serviceEnvironment),
    }),
  );
  expect(io.restart).toHaveBeenCalledExactlyOnceWith("gateway.runtime-unavailable");
  expect(io.warn).toHaveBeenCalledWith(expect.stringMatching(/^restart-requested:/));
  expect(runtime.readChildRuntimeViability()).toEqual({
    execPath: process.execPath,
    available: false,
  });
});
