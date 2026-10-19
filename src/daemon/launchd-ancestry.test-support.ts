import "./launchd-fs.mocks.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { GATEWAY_SERVICE_KIND, GATEWAY_SERVICE_MARKER } from "./constants.js";
import {
  createDefaultLaunchdEnv,
  createTestLaunchAgentPlist,
  defaultLaunchAgentFixture,
  defaultProgramArguments,
  launchAgentControlFixture,
} from "./launchd-install.test-support.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import { launchdTestState as state } from "./launchd-state.test-support.js";
import {
  installLaunchAgent as installLaunchAgentImpl,
  parkCurrentLaunchAgentForMaintenance,
  resolveLaunchAgentPlistPath,
  restartLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
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
const ENV = createDefaultLaunchdEnv();
const DOMAIN = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
const SERVICE_ID = `${DOMAIN}/ai.openclaw.gateway`;
const EXTERNAL_PROCESS = {
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
    if (state.printOutput) {
      return printed(state.printOutput);
    }
    if (!state.serviceRunning) {
      return printed("state = waiting\npid = 0");
    }
    return printed("state = running\npid = 4242");
  }
  if (call[0] === "disable" && state.disableError) {
    return commandResult("", state.disableError, state.disableCode);
  }
  if (call[0] === "bootout") {
    if (state.bootoutError) {
      return commandResult("", state.bootoutError, state.bootoutCode);
    }
    if (!state.bootoutLeavesLoaded) {
      state.serviceLoaded = false;
      state.serviceRunning = false;
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
      // Transient failures clear after one attempt so recovery paths that retry
      // a bootstrap can be exercised the way launchd behaves once a booted-out
      // job finishes tearing down.
      if (state.bootstrapTransient) {
        state.bootstrapError = "";
      }
      if (state.bootstrapLoadsServiceOnFailure) {
        state.serviceLoaded = true;
        state.serviceRunning = true;
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
  state.serviceLoaded = true;
  state.serviceRunning = true;
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

vi.mock("../infra/restart-stale-pids.js", () => ({
  getSelfAndAncestorPidsSync,
  cleanStaleGatewayProcessesSync: (port?: number, options?: CleanStaleGatewayProcessesOptions) =>
    options === undefined
      ? cleanStaleGatewayProcessesSync(port)
      : cleanStaleGatewayProcessesSync(port, options),
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
  state.launchctlCalls.length = 0;
  isPidDefinitelyDead.mockReturnValue(true);
  for (const collection of [
    state.dirs,
    state.dirModes,
    state.files,
    state.fileModes,
    state.serviceStates,
  ]) {
    collection.clear();
  }
  state.fileWrites.length = 0;
  state.cleanupProtectedPids.length = 0;
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

export function registerLaunchdAncestryTests() {
  describe("launchd process ancestry guards", () => {
    const restartHandoff = launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff;
    beforeEach(() => {
      for (const key of Object.keys(EXTERNAL_PROCESS)) {
        vi.stubEnv(key, undefined);
      }
    });
    const installOrUninstall = (action: "install" | "uninstall") =>
      action === "install"
        ? installLaunchAgent(defaultLaunchAgentFixture(ENV))
        : uninstallLaunchAgent(launchAgentControlFixture(ENV));
    it.each([
      { action: "install", native: false },
      { action: "uninstall", native: false },
      { action: "install", native: true },
      { action: "uninstall", native: true },
    ] as const)(
      "allows external $action with inherited service markers (native: $native)",
      async ({ action, native }) => {
        state.files.set(
          resolveLaunchAgentPlistPath(ENV),
          createTestLaunchAgentPlist({
            label: "ai.openclaw.gateway",
            programArguments: defaultProgramArguments,
          }),
        );
        for (const [key, value] of Object.entries({
          XPC_SERVICE_NAME: native ? "ai.openclaw.gateway" : "0",
          OPENCLAW_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
          OPENCLAW_SERVICE_KIND: GATEWAY_SERVICE_KIND,
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
        })) {
          vi.stubEnv(key, value);
        }
        await expect(installOrUninstall(action)).resolves.not.toThrow();
        expect(getSelfAndAncestorPidsSync).toHaveBeenCalled();
      },
    );

    it.each([
      ["a Gateway ancestor", true, 4242],
      ["an external caller", false, 4242],
      ["a service PID matching the host PID", false, process.pid],
      ["a service PID matching the host parent PID", false, process.ppid],
    ] as const)("restarts without env markers with %s", async (_name, inside, servicePid) => {
      state.printOutput = ["state = running", `pid = ${servicePid}`].join("\n");
      if (inside) {
        getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));
      }

      const result = await restartLaunchAgent(launchAgentControlFixture(ENV));

      expect(getSelfAndAncestorPidsSync).toHaveBeenCalledOnce();
      if (inside) {
        expect(result).toEqual({ outcome: "scheduled" });
        expect(restartHandoff).toHaveBeenCalledWith({
          env: ENV,
          mode: "kickstart",
          waitForPid: process.pid,
        });
        expect(state.launchctlCalls).toStrictEqual([["print", SERVICE_ID]]);
        expect(cleanStaleGatewayProcessesSync).not.toHaveBeenCalled();
      } else {
        expect(result).toEqual({ outcome: "completed" });
        expect(restartHandoff).not.toHaveBeenCalled();
        expect(state.launchctlCalls).toStrictEqual([
          ["print", SERVICE_ID],
          ["enable", SERVICE_ID],
          ["kickstart", "-k", SERVICE_ID],
        ]);
      }
    });

    it.each([false, true])(
      "refuses stop without env markers with a Gateway ancestor (disable: %s)",
      async (disable) => {
        getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));

        await expect(stopLaunchAgent(launchAgentControlFixture(ENV, { disable }))).rejects.toThrow(
          "Refusing to stop LaunchAgent ai.openclaw.gateway from inside the same launchd service",
        );

        expect(state.launchctlCalls).toEqual([["print", SERVICE_ID]]);
      },
    );

    it("parks without env markers when the Gateway is an ancestor", async () => {
      getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));

      await expect(parkCurrentLaunchAgentForMaintenance({ env: ENV })).resolves.toBe(true);

      expect(state.launchctlCalls).toEqual([
        ["print", SERVICE_ID],
        ["disable", SERVICE_ID],
      ]);
      expect(
        launchdRestartHandoffState.scheduleDetachedLaunchdMaintenancePark,
      ).toHaveBeenCalledWith({
        env: ENV,
        waitForPid: process.pid,
      });
    });

    it.each(["install", "uninstall"] as const)(
      "refuses %s without env markers with a Gateway ancestor",
      async (action) => {
        state.serviceStates.set(SERVICE_ID, "running");
        getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));

        await expect(installOrUninstall(action)).rejects.toThrow(
          `Refusing to ${action} LaunchAgent ai.openclaw.gateway from inside ai.openclaw.gateway`,
        );

        expect(state.fileWrites).toEqual([]);
        expect(state.launchctlCalls).toEqual([["print", SERVICE_ID]]);
      },
    );

    it("refuses install from a legacy Gateway ancestor after probing the target first", async () => {
      const legacyServiceId = `${DOMAIN}/ai.openclaw.legacy-gateway`;
      state.serviceStates.set(SERVICE_ID, "not-loaded");
      state.serviceStates.set(legacyServiceId, "running");
      getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));

      vi.stubEnv("OPENCLAW_LAUNCHD_LABEL", "ai.openclaw.legacy-gateway");
      await expect(installLaunchAgent(defaultLaunchAgentFixture(ENV))).rejects.toThrow(
        "Refusing to install LaunchAgent ai.openclaw.gateway from inside ai.openclaw.legacy-gateway",
      );

      expect(state.fileWrites).toEqual([]);
      expect(state.launchctlCalls).toEqual([
        ["print", SERVICE_ID],
        ["print", legacyServiceId],
      ]);
      expect(getSelfAndAncestorPidsSync).toHaveBeenCalledOnce();
    });
  });
}
