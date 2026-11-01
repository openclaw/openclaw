import "./launchd-fs.mocks.test-support.js";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createDefaultLaunchdEnv,
  createTestLaunchAgentPlist,
  defaultProgramArguments,
} from "./launchd-install.test-support.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import { launchdTestState as state } from "./launchd-state.test-support.js";
import {
  installLaunchAgent as installLaunchAgentImpl,
  resolveLaunchAgentPlistPath,
} from "./launchd.js";

type ScheduleHandoff = (
  _params: unknown,
) => { ok: true; value: Promise<boolean> } | { ok: false; error: string };
const launchdRestartHandoffState = vi.hoisted(() => ({
  scheduleDetachedLaunchdMaintenancePark: vi.fn<ScheduleHandoff>(),
  scheduleDetachedLaunchdRestartHandoff: vi.fn<ScheduleHandoff>(),
}));
const launchdSystemState = vi.hoisted(() => ({
  assertNoSystemLaunchDaemonOwnership:
    vi.fn<typeof import("./launchd-system.js").assertNoSystemLaunchDaemonOwnership>(),
  inspectSystemLaunchDaemonOwnership:
    vi.fn<typeof import("./launchd-system.js").inspectSystemLaunchDaemonOwnership>(),
}));
type CleanStaleGatewayProcessesOptions = {
  protectedPid?: number;
  resolveProtectedPid?: () => number | undefined;
};

const cleanStaleGatewayProcessesSync = vi.hoisted(() =>
  vi.fn<(port?: number, options?: CleanStaleGatewayProcessesOptions) => number[]>(() => []),
);
const nativeServiceMembership = vi.hoisted(() => vi.fn<() => "inside" | "outside" | "unknown">());
vi.mock("./service-process-membership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service-process-membership.js")>()),
  inspectServiceProcessMembershipSync: nativeServiceMembership,
}));
const getSelfAndAncestorPidsSync = vi.hoisted(() => vi.fn<() => Set<number>>());
const launchdCallerPids = vi.hoisted(() => {
  // Keep the synthetic caller graph separate from host PIDs and both service fixture PIDs.
  const caller = Math.max(process.pid, process.ppid, 4242, 4343) + 1;
  return [caller, caller + 1];
});
const launchctlSpawnSync = vi.hoisted(() => vi.fn());
export const ENV = createDefaultLaunchdEnv();
export const DOMAIN = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
export const SERVICE_ID = `${DOMAIN}/ai.openclaw.gateway`;
export const GUI_UNAVAILABLE = "Bootstrap failed: 125: Domain does not support specified action";
export const EXTERNAL_PROCESS = {
  LAUNCH_JOB_LABEL: undefined,
  LAUNCH_JOB_NAME: undefined,
  XPC_SERVICE_NAME: undefined,
  OPENCLAW_SERVICE_MARKER: undefined,
  OPENCLAW_SERVICE_KIND: undefined,
  OPENCLAW_LAUNCHD_LABEL: undefined,
};
const inspectPortUsage = vi.hoisted(() =>
  vi.fn<typeof import("../infra/ports-inspect.js").inspectPortUsage>(),
);
const probePortUsage = vi.hoisted(() =>
  vi.fn<typeof import("../infra/ports-probe.js").probePortUsage>(async () => "free"),
);
const formatPortDiagnostics = vi.hoisted(() => vi.fn(() => ["Port 18789 is already in use."]));
const resolveGatewayServiceProbeHosts = vi.hoisted(() =>
  vi.fn<(_params?: unknown) => Promise<readonly string[]>>(async () => ["127.0.0.1"]),
);
export function setLegacyGatewayLaunchAgentPlist(plistPath: string, extraLines: string[]): void {
  state.files.set(
    plistPath,
    createTestLaunchAgentPlist({
      label: "ai.openclaw.gateway",
      programArguments: ["node", "gateway.js"],
    })
      .replace("  </dict>", `${extraLines.join("\n")}\n  </dict>`)
      .trimEnd(),
  );
}

export function setLaunchAgentPlist(
  env: Record<string, string | undefined>,
  label: string,
  programArguments: string[],
  environment?: Record<string, string>,
): string {
  const plist = createTestLaunchAgentPlist({ label, programArguments, environment });
  state.files.set(`${env.HOME}/Library/LaunchAgents/${label}.plist`, plist);
  return plist;
}

export function setGatewayPlist(
  programArguments = defaultProgramArguments,
  environment?: Record<string, string>,
) {
  return setLaunchAgentPlist(ENV, "ai.openclaw.gateway", programArguments, environment);
}

export function expectServiceCalls(...commands: (string | string[])[]) {
  expect(state.launchctlCalls).toEqual(
    commands.map((command) =>
      typeof command === "string" ? [command, SERVICE_ID] : command.concat(SERVICE_ID),
    ),
  );
}

export async function installLaunchAgent(
  args: Parameters<typeof installLaunchAgentImpl>[0],
): ReturnType<typeof installLaunchAgentImpl> {
  if (
    !state.files.has(resolveLaunchAgentPlistPath(args.env)) &&
    !state.serviceStates.has(SERVICE_ID)
  ) {
    // A cached job without a rollback plist must opt in explicitly.
    state.serviceLoaded = false;
    state.serviceRunning = false;
  }
  return await installLaunchAgentImpl(args);
}

function normalizeLaunchctlArgs(file: string, args: string[]): string[] {
  const idx = file === "launchctl" ? -1 : args.indexOf("launchctl");
  return idx >= 0 ? args.slice(idx + 1) : args;
}

function commandResult(stdout = "", stderr = "", code = 0) {
  return { stdout, stderr, code };
}

function executeLaunchctlMock(file: string, args: string[]) {
  const call = normalizeLaunchctlArgs(file, args);
  state.launchctlCalls.push(call);
  if (call[0] === "list") {
    return commandResult(state.listOutput);
  }
  if (call[0] === "print-disabled") {
    return commandResult(
      state.printDisabledOutput,
      state.printDisabledError,
      state.printDisabledCode,
    );
  }
  if (call[0] === "print") {
    const printed = (fields: string) =>
      commandResult(
        [`${call[1]} = {`, ...fields.split("\n").map((line) => `\t${line}`), "}"].join("\n"),
      );
    if (state.printNotLoadedRemaining > 0) {
      state.printNotLoadedRemaining -= 1;
      return commandResult("", "Could not find service", 113);
    }
    if (state.printError && state.printFailuresRemaining > 0) {
      state.printFailuresRemaining -= 1;
      return commandResult("", state.printError, state.printCode);
    }
    const serviceState = state.serviceStates.get(call[1] ?? "");
    if (serviceState === "not-loaded" || (!serviceState && !state.serviceLoaded)) {
      return commandResult("", "Could not find service", 113);
    }
    if (serviceState) {
      return printed(
        serviceState === "running" ? "state = running\npid = 4242" : "state = waiting\npid = 0",
      );
    }
    return printed(
      state.printOutput ||
        (state.serviceRunning ? "state = running\npid = 4242" : "state = waiting\npid = 0"),
    );
  }
  if (call[0] === "disable" && state.disableError) {
    return commandResult("", state.disableError, state.disableCode);
  }
  if (call[0] === "bootout") {
    if (state.bootoutError) {
      return commandResult("", state.bootoutError, state.bootoutCode);
    }
    if (!state.bootoutLeavesLoaded) {
      Object.assign(state, { serviceLoaded: false, serviceRunning: false });
    }
    return commandResult();
  }
  if (call[0] === "enable" || call[0] === "disable") {
    const override = call[0] === "enable" ? "enabled" : "disabled";
    state.printDisabledOutput = `disabled services = {\n\t"ai.openclaw.gateway" => ${override}\n}`;
    return commandResult();
  }
  if (call[0] === "bootstrap") {
    if (state.printDisabledOutput.includes('"ai.openclaw.gateway" => disabled')) {
      return commandResult("", "Service is disabled", 5);
    }
    if (state.bootstrapError) {
      const detail = state.bootstrapError;
      // Model a booted-out job finishing teardown after one bootstrap attempt.
      state.bootstrapError = state.bootstrapTransient ? "" : detail;
      if (state.bootstrapLoadsServiceOnFailure) {
        Object.assign(state, { serviceLoaded: true, serviceRunning: true });
      }
      return {
        ...commandResult("", detail, state.bootstrapCode),
        termination: state.bootstrapTermination,
      };
    }
  } else if (call[0] === "kickstart") {
    if (state.kickstartFailuresRemaining > 0) {
      state.kickstartFailuresRemaining -= 1;
      if (state.kickstartUnloadsService) {
        state.serviceLoaded = false;
      }
      return commandResult("", state.kickstartError, state.kickstartCode);
    }
  } else {
    return commandResult();
  }
  Object.assign(state, { serviceLoaded: true, serviceRunning: true });
  return commandResult();
}

const isPidDefinitelyDead = vi.hoisted(() => vi.fn(() => true));
vi.mock("../shared/pid-alive.js", () => ({ isPidDefinitelyDead }));

vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runExec: vi.fn(
    async (_command: string, args: string[], options: { input: string | Uint8Array }) =>
      decodeLaunchAgentPlistFixture(options.input, args[1]),
  ),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    { spawnSync: (...args: unknown[]) => launchctlSpawnSync(...args) },
  );
});

vi.mock("./exec-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./exec-file.js")>();
  return {
    execFileUtf8: vi.fn(async (...args: Parameters<typeof actual.execFileUtf8>) =>
      state.realExecFile
        ? await actual.execFileUtf8(...args)
        : { termination: "exit" as const, ...executeLaunchctlMock(args[0], args[1]) },
    ),
  };
});

// mock-isolation: Record restart handoffs without launching detached processes.
vi.mock("./launchd-restart-handoff.js", () => launchdRestartHandoffState);

// mock-isolation: System ownership comes from the synthetic launchd state.
vi.mock("./launchd-system.js", () => ({
  ...launchdSystemState,
  formatSystemLaunchDaemonOwnershipSummary: (ownership: { serviceTarget: string }) =>
    `System LaunchDaemon ${ownership.serviceTarget} already owns this gateway label.`,
  isSystemLaunchDaemonOwnershipError: (error: unknown) =>
    (error as { code?: string } | null)?.code === "SYSTEM_LAUNCH_DAEMON_OWNERSHIP",
}));

// mock-isolation: Process ancestry and cleanup use the suite's synthetic service processes.
vi.mock("../infra/restart-stale-pids.js", () => ({
  getSelfAndAncestorPidsSync,
  cleanStaleGatewayProcessesSync,
}));

// mock-isolation: Port diagnostics must match the synthetic listener state.
vi.mock("../infra/ports-format.js", () => ({ formatPortDiagnostics }));

vi.mock("../infra/ports-inspect.js", () => ({ inspectPortUsage }));

vi.mock("../infra/ports-probe.js", () => ({
  LOOPBACK_PORT_PROBE_HOSTS: ["127.0.0.1"],
  probePortUsage,
}));

// mock-isolation: Probe only the addresses supplied by each launchd scenario.
vi.mock("./gateway-service-probe-hosts.js", () => ({
  resolveGatewayServiceProbeHosts,
}));

const filesystemDirs = useAutoCleanupTempDirTracker(afterEach);
const initialState = { ...state };

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  // Reset from the state fixture's defaults, retaining the filesystem mock's installed resolver.
  Object.assign(state, initialState, {
    fsRoot: filesystemDirs.make("openclaw-launchd-fs-"),
    resolveFsPath: state.resolveFsPath,
    printDisabledOutput: 'disabled services = {\n\t"ai.openclaw.gateway" => enabled\n}',
  });
  isPidDefinitelyDead.mockReturnValue(true);
  for (const value of Object.values(state)) {
    if (Array.isArray(value)) {
      value.length = 0;
    } else if (value instanceof Set || value instanceof Map) {
      value.clear();
    }
  }
  launchctlSpawnSync.mockReset().mockImplementation((file: string, args: string[]) => {
    const result = executeLaunchctlMock(file, args);
    return { ...result, status: result.code, error: undefined };
  });
  getSelfAndAncestorPidsSync.mockReset().mockReturnValue(new Set([...launchdCallerPids, 1]));
  nativeServiceMembership.mockReset().mockReturnValue("outside");
  cleanStaleGatewayProcessesSync.mockReset().mockImplementation((_port, options) => {
    state.cleanupProtectedPids.push(options?.resolveProtectedPid?.() ?? options?.protectedPid);
    return [];
  });
  inspectPortUsage
    .mockReset()
    .mockResolvedValue({ port: 18789, status: "free", listeners: [], hints: [] });
  probePortUsage.mockReset().mockResolvedValue("free");
  formatPortDiagnostics.mockReset().mockReturnValue(["Port 18789 is already in use."]);
  resolveGatewayServiceProbeHosts.mockReset().mockResolvedValue(["127.0.0.1"]);
  for (const schedule of Object.values(launchdRestartHandoffState)) {
    schedule.mockReset().mockReturnValue({ ok: true, value: Promise.resolve(true) });
  }
  launchdSystemState.assertNoSystemLaunchDaemonOwnership.mockReset().mockResolvedValue();
  launchdSystemState.inspectSystemLaunchDaemonOwnership
    .mockReset()
    .mockImplementation(async (label) => ({
      status: "absent",
      serviceTarget: `system/${label}`,
    }));
  vi.clearAllMocks();
});

export {
  nativeServiceMembership,
  launchdRestartHandoffState,
  launchdSystemState,
  cleanStaleGatewayProcessesSync,
  getSelfAndAncestorPidsSync,
  launchdCallerPids,
  launchctlSpawnSync,
  inspectPortUsage,
  probePortUsage,
  formatPortDiagnostics,
  resolveGatewayServiceProbeHosts,
  isPidDefinitelyDead,
};
