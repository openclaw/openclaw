import "./launchd-fs.mocks.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
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

const launchdRestartHandoffState = vi.hoisted(() => ({
  scheduleDetachedLaunchdMaintenancePark: vi.fn<
    (_params: unknown) => { ok: true; value: Promise<boolean> } | { ok: false; error: string }
  >(() => ({ ok: true, value: Promise.resolve(true) })),
  scheduleDetachedLaunchdRestartHandoff: vi.fn<
    (_params: unknown) => { ok: true; value: Promise<boolean> } | { ok: false; error: string }
  >(() => ({ ok: true, value: Promise.resolve(true) })),
}));
const launchdSystemState = vi.hoisted(() => ({
  assertNoSystemLaunchDaemonOwnership: vi.fn<(label: string) => Promise<void>>(async () => {}),
  inspectSystemLaunchDaemonOwnership: vi.fn<
    (
      label: string,
      options?: { scanInstalledPlists?: boolean },
    ) => Promise<{
      status: "absent" | "loaded" | "unverifiable";
      serviceTarget: string;
      operation?: "launchctl";
      detail?: string;
    }>
  >(async (label: string) => ({
    status: "absent" as const,
    serviceTarget: `system/${label}`,
  })),
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
  vi.fn<typeof import("../infra/ports-inspect.js").inspectPortUsage>(async () => ({
    port: 18789,
    status: "free",
    listeners: [],
    hints: [],
  })),
);
const probePortUsage = vi.hoisted(() =>
  vi.fn<typeof import("../infra/ports-probe.js").probePortUsage>(async () => "free"),
);
const formatPortDiagnostics = vi.hoisted(() => vi.fn(() => ["Port 18789 is already in use."]));
const resolveGatewayServiceProbeHosts = vi.hoisted(() =>
  vi.fn<(_params?: unknown) => Promise<readonly string[]>>(async () => ["127.0.0.1"]),
);
function setLegacyGatewayLaunchAgentPlist(plistPath: string, extraLines: string[]): void {
  state.files.set(
    plistPath,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0">',
      "  <dict>",
      "    <key>Label</key>",
      "    <string>ai.openclaw.gateway</string>",
      "    <key>ProgramArguments</key>",
      "    <array>",
      "      <string>node</string>",
      "      <string>gateway.js</string>",
      "    </array>",
      ...extraLines,
      "  </dict>",
      "</plist>",
    ].join("\n"),
  );
}

async function installLaunchAgent(
  args: Parameters<typeof installLaunchAgentImpl>[0],
): ReturnType<typeof installLaunchAgentImpl> {
  const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
  const serviceTarget = `${domain}/ai.openclaw.gateway`;
  if (
    !state.files.has(resolveLaunchAgentPlistPath(args.env)) &&
    !state.serviceStates.has(serviceTarget)
  ) {
    // Most install cases model a genuinely fresh definition. Cached jobs with
    // no plist must opt in explicitly because they have no rollback artifact.
    state.serviceLoaded = false;
    state.serviceRunning = false;
  }
  return await installLaunchAgentImpl(args);
}

function normalizeLaunchctlArgs(file: string, args: string[]): string[] {
  if (file === "launchctl") {
    return args;
  }
  const idx = args.indexOf("launchctl");
  if (idx >= 0) {
    return args.slice(idx + 1);
  }
  return args;
}

function commandResult(stdout = "", stderr = "", code = 0) {
  return { stdout, stderr, code };
}

function missingService() {
  return commandResult("", "Could not find service", 113);
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
      return missingService();
    }
    if (state.printError && state.printFailuresRemaining > 0) {
      state.printFailuresRemaining -= 1;
      return commandResult("", state.printError, state.printCode);
    }
    const serviceState = state.serviceStates.get(call[1] ?? "");
    if (serviceState === "not-loaded") {
      return missingService();
    }
    if (serviceState === "stopped") {
      return printed("state = waiting\npid = 0");
    }
    if (serviceState === "running") {
      return printed("state = running\npid = 4242");
    }
    if (!state.serviceLoaded) {
      return missingService();
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
  if (call[0] === "enable") {
    state.printDisabledOutput = 'disabled services = {\n\t"ai.openclaw.gateway" => enabled\n}';
    return commandResult();
  }
  if (call[0] === "disable") {
    state.printDisabledOutput = 'disabled services = {\n\t"ai.openclaw.gateway" => disabled\n}';
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
    state.serviceLoaded = true;
    state.serviceRunning = true;
    return commandResult();
  }
  if (call[0] === "kickstart") {
    if (state.kickstartFailuresRemaining > 0) {
      state.kickstartFailuresRemaining -= 1;
      if (state.kickstartUnloadsService) {
        state.serviceLoaded = false;
      }
      return commandResult("", state.kickstartError, state.kickstartCode);
    }
    state.serviceLoaded = true;
    state.serviceRunning = true;
    return commandResult();
  }
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

vi.mock("./launchd-restart-handoff.js", () => ({
  scheduleDetachedLaunchdMaintenancePark: (params: unknown) =>
    launchdRestartHandoffState.scheduleDetachedLaunchdMaintenancePark(params),
  scheduleDetachedLaunchdRestartHandoff: (params: unknown) =>
    launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff(params),
}));

vi.mock("./launchd-system.js", () => ({
  assertNoSystemLaunchDaemonOwnership: (label: string) =>
    launchdSystemState.assertNoSystemLaunchDaemonOwnership(label),
  inspectSystemLaunchDaemonOwnership: (
    label: string,
    options?: { scanInstalledPlists?: boolean },
  ) => launchdSystemState.inspectSystemLaunchDaemonOwnership(label, options),
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

vi.mock("../infra/ports-format.js", () => ({
  formatPortDiagnostics,
}));

vi.mock("../infra/ports-inspect.js", () => ({ inspectPortUsage }));

vi.mock("../infra/ports-probe.js", () => ({
  LOOPBACK_PORT_PROBE_HOSTS: ["127.0.0.1"],
  probePortUsage,
}));

vi.mock("./gateway-service-probe-hosts.js", () => ({
  resolveGatewayServiceProbeHosts: (params: unknown) => resolveGatewayServiceProbeHosts(params),
}));

const filesystemDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  state.fsRoot = filesystemDirs.make("openclaw-launchd-fs-");
  state.launchctlCalls.length = 0;
  state.listOutput = "";
  state.printOutput = "";
  state.printDisabledOutput = 'disabled services = {\n\t"ai.openclaw.gateway" => enabled\n}';
  state.printDisabledError = "";
  state.printDisabledCode = 0;
  state.printNotLoadedRemaining = 0;
  state.printError = "";
  state.printCode = 1;
  state.printFailuresRemaining = 0;
  state.bootstrapError = "";
  state.bootstrapCode = 1;
  state.bootstrapTermination = "exit";
  state.bootstrapLoadsServiceOnFailure = false;
  state.bootstrapTransient = false;
  state.kickstartError = "";
  state.kickstartCode = 1;
  state.kickstartFailuresRemaining = 0;
  state.kickstartUnloadsService = false;
  state.disableError = "";
  state.disableCode = 1;
  state.bootoutError = "";
  state.bootoutCode = 1;
  state.bootoutLeavesLoaded = false;
  isPidDefinitelyDead.mockReturnValue(true);
  state.serviceLoaded = true;
  state.serviceRunning = true;
  state.dirs.clear();
  state.dirModes.clear();
  state.files.clear();
  state.fileModes.clear();
  state.fileWrites.length = 0;
  state.cleanupProtectedPids.length = 0;
  state.realExecFile = false;
  state.serviceStates.clear();
  launchctlSpawnSync.mockReset();
  launchctlSpawnSync.mockImplementation((file: string, args: string[]) => {
    const result = executeLaunchctlMock(file, args);
    return { ...result, status: result.code, error: undefined };
  });
  cleanStaleGatewayProcessesSync.mockReset();
  getSelfAndAncestorPidsSync.mockReset();
  getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 1]));
  nativeServiceMembership.mockReset().mockReturnValue("outside");
  cleanStaleGatewayProcessesSync.mockImplementation((_port, options) => {
    state.cleanupProtectedPids.push(options?.resolveProtectedPid?.() ?? options?.protectedPid);
    return [];
  });
  inspectPortUsage.mockReset();
  inspectPortUsage.mockResolvedValue({ port: 18789, status: "free", listeners: [], hints: [] });
  probePortUsage.mockReset();
  probePortUsage.mockResolvedValue("free");
  formatPortDiagnostics.mockReset();
  formatPortDiagnostics.mockReturnValue(["Port 18789 is already in use."]);
  resolveGatewayServiceProbeHosts.mockReset();
  resolveGatewayServiceProbeHosts.mockResolvedValue(["127.0.0.1"]);
  launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff.mockReset();
  launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff.mockReturnValue({
    ok: true,
    value: Promise.resolve(true),
  });
  launchdRestartHandoffState.scheduleDetachedLaunchdMaintenancePark.mockReset();
  launchdRestartHandoffState.scheduleDetachedLaunchdMaintenancePark.mockReturnValue({
    ok: true,
    value: Promise.resolve(true),
  });
  launchdSystemState.assertNoSystemLaunchDaemonOwnership.mockReset();
  launchdSystemState.assertNoSystemLaunchDaemonOwnership.mockResolvedValue();
  launchdSystemState.inspectSystemLaunchDaemonOwnership.mockReset();
  launchdSystemState.inspectSystemLaunchDaemonOwnership.mockImplementation(async (label) => ({
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
  setLegacyGatewayLaunchAgentPlist,
  installLaunchAgent,
  isPidDefinitelyDead,
};

export function registerLaunchdAncestryTests() {
  describe("launchd process ancestry guards", () => {
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
        await withEnvAsync(
          {
            ...EXTERNAL_PROCESS,
            XPC_SERVICE_NAME: native ? "ai.openclaw.gateway" : "0",
            OPENCLAW_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
            OPENCLAW_SERVICE_KIND: GATEWAY_SERVICE_KIND,
            OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
          },
          async () => {
            await expect(
              action === "install"
                ? installLaunchAgent(defaultLaunchAgentFixture(ENV))
                : uninstallLaunchAgent(launchAgentControlFixture(ENV)),
            ).resolves.not.toThrow();
          },
        );
        expect(getSelfAndAncestorPidsSync).toHaveBeenCalled();
      },
    );

    it.each([
      { name: "a Gateway ancestor", inside: true, servicePid: 4242 },
      { name: "an external caller", inside: false, servicePid: 4242 },
      { name: "a service PID matching the host PID", inside: false, servicePid: process.pid },
      {
        name: "a service PID matching the host parent PID",
        inside: false,
        servicePid: process.ppid,
      },
    ])("restarts without env markers with $name", async ({ inside, servicePid }) => {
      state.printOutput = ["state = running", `pid = ${servicePid}`].join("\n");
      if (inside) {
        getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));
      }

      const result = await withEnvAsync(EXTERNAL_PROCESS, async () =>
        restartLaunchAgent(launchAgentControlFixture(ENV)),
      );

      expect(getSelfAndAncestorPidsSync).toHaveBeenCalledOnce();
      if (inside) {
        expect(result).toEqual({ outcome: "scheduled" });
        expect(
          launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff,
        ).toHaveBeenCalledWith({
          env: ENV,
          mode: "kickstart",
          waitForPid: process.pid,
        });
        expect(state.launchctlCalls).toStrictEqual([["print", SERVICE_ID]]);
        expect(cleanStaleGatewayProcessesSync).not.toHaveBeenCalled();
      } else {
        expect(result).toEqual({ outcome: "completed" });
        expect(
          launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff,
        ).not.toHaveBeenCalled();
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

        await withEnvAsync(EXTERNAL_PROCESS, async () => {
          await expect(
            stopLaunchAgent(launchAgentControlFixture(ENV, { disable })),
          ).rejects.toThrow(
            "Refusing to stop LaunchAgent ai.openclaw.gateway from inside the same launchd service",
          );
        });

        expect(state.launchctlCalls).toEqual([["print", SERVICE_ID]]);
      },
    );

    it("parks without env markers when the Gateway is an ancestor", async () => {
      getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));

      await withEnvAsync(EXTERNAL_PROCESS, async () => {
        await expect(parkCurrentLaunchAgentForMaintenance({ env: ENV })).resolves.toBe(true);
      });

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

        await withEnvAsync(EXTERNAL_PROCESS, async () => {
          await expect(
            action === "install"
              ? installLaunchAgent(defaultLaunchAgentFixture(ENV))
              : uninstallLaunchAgent(launchAgentControlFixture(ENV)),
          ).rejects.toThrow(
            `Refusing to ${action} LaunchAgent ai.openclaw.gateway from inside ai.openclaw.gateway`,
          );
        });

        expect(state.fileWrites).toEqual([]);
        expect(state.launchctlCalls).toEqual([["print", SERVICE_ID]]);
      },
    );

    it("refuses install from a legacy Gateway ancestor after probing the target first", async () => {
      const legacyServiceId = `${DOMAIN}/ai.openclaw.legacy-gateway`;
      state.serviceStates.set(SERVICE_ID, "not-loaded");
      state.serviceStates.set(legacyServiceId, "running");
      getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));

      await withEnvAsync(
        {
          ...EXTERNAL_PROCESS,
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.legacy-gateway",
        },
        async () => {
          await expect(installLaunchAgent(defaultLaunchAgentFixture(ENV))).rejects.toThrow(
            "Refusing to install LaunchAgent ai.openclaw.gateway from inside ai.openclaw.legacy-gateway",
          );
        },
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
