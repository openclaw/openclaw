await vi.hoisted(() => import("./launchd-ancestry.test-support.js"));
import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { GATEWAY_SERVICE_KIND, GATEWAY_SERVICE_MARKER } from "./constants.js";
import {
  ENV,
  DOMAIN,
  SERVICE_ID,
  EXTERNAL_PROCESS,
  GUI_UNAVAILABLE,
  nativeServiceMembership,
  getSelfAndAncestorPidsSync,
  launchdCallerPids,
  launchdRestartHandoffState,
  launchdSystemState,
  cleanStaleGatewayProcessesSync,
  inspectPortUsage,
  probePortUsage,
  installLaunchAgent,
  setLegacyGatewayLaunchAgentPlist,
  setLaunchAgentPlist,
  setGatewayPlist,
  expectServiceCalls,
} from "./launchd-ancestry.test-support.js";
import {
  defaultLaunchAgentFixture,
  launchAgentControlFixture,
} from "./launchd-install.test-support.js";
import { LAUNCH_AGENT_ENV_WRAPPER_SHELL } from "./launchd-plist.js";
import { launchdTestState as state } from "./launchd-state.test-support.js";
import {
  disableCurrentOpenClawUpdateLaunchdJob,
  findStaleOpenClawUpdateLaunchdJobs,
  isLaunchAgentEnabled,
  isLaunchAgentLoaded,
  parkCurrentLaunchAgentForMaintenance,
  parseLaunchAgentEnabled,
  readLaunchAgentRuntime,
  restartLaunchAgent,
  resolveLaunchAgentPlistPath,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";
const {
  scheduleDetachedLaunchdRestartHandoff: handoff,
  scheduleDetachedLaunchdMaintenancePark: park,
} = launchdRestartHandoffState;
const install = () => installLaunchAgent(defaultLaunchAgentFixture(ENV));
const control = (overrides?: Parameters<typeof launchAgentControlFixture>[1]) =>
  launchAgentControlFixture(ENV, overrides);

it("does not mistake a co-located Gateway port for the node-host port during restart", async () => {
  const env = {
    ...ENV,
    OPENCLAW_SERVICE_KIND: "node",
    OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.node",
    OPENCLAW_GATEWAY_PORT: "18789",
  };
  setLaunchAgentPlist(env, "ai.openclaw.node", [
    "node",
    "node",
    "run",
    "--host",
    "127.0.0.1",
    "--port",
    "18789",
  ]);
  const stdout = new PassThrough();
  inspectPortUsage.mockResolvedValue({
    port: 18789,
    status: "busy",
    listeners: [{ pid: 9999, address: "TCP 127.0.0.1:18789 (LISTEN)" }],
    hints: [],
  });
  probePortUsage.mockResolvedValue("busy");
  const result = await withEnvAsync(EXTERNAL_PROCESS, () => restartLaunchAgent({ env, stdout }));
  expect(inspectPortUsage).not.toHaveBeenCalled();
  expect(cleanStaleGatewayProcessesSync).not.toHaveBeenCalled();
  expect(result).toEqual({ outcome: "completed" });
});

describe("launchd runtime parsing", () => {
  it.each([
    ['disabled services = {\n\t"other.service" => disabled\n}', true],
    ['disabled services = {\n\t"ai.openclaw.gateway" => unexpected\n}', "unrecognized state"],
  ] as const)("parses the LaunchAgent enabled override %j", (output, expected) => {
    const parse = () => parseLaunchAgentEnabled(output, "ai.openclaw.gateway");
    if (typeof expected === "string") {
      expect(parse).toThrow(expected);
    } else {
      expect(parse()).toBe(expected);
    }
  });

  it.each(["enabled", "loaded"] as const)(
    "fails closed when the %s state cannot be read",
    async (read) => {
      if (read === "enabled") {
        state.printDisabledError = "Operation not permitted";
        state.printDisabledCode = 1;
        await expect(isLaunchAgentEnabled({ env: ENV })).rejects.toThrow(
          "launchctl print-disabled failed: Operation not permitted",
        );
      } else {
        state.printError = "launchctl print permission denied";
        state.printFailuresRemaining = 1;
        await expect(isLaunchAgentLoaded({ env: ENV })).rejects.toMatchObject({
          reason: "launchd-gui-domain-unavailable",
        });
      }
    },
  );
});

describe("launchd runtime state", () => {
  it.runIf(process.platform === "darwin").each(["runtime", "enabled"] as const)(
    "bounds the %s read by the supplied deadline when launchctl blocks",
    async (read) => {
      const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const tempDir = await realFs.mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/openclaw-launchd-`);
      await realFs.writeFile(`${tempDir}/launchctl`, "#!/bin/sh\nexec /bin/sleep 2\n", {
        mode: 0o755,
      });
      state.realExecFile = true;

      try {
        await withEnvAsync({ PATH: `${tempDir}:${process.env.PATH ?? ""}` }, async () => {
          const startedAt = Date.now();
          if (read === "enabled") {
            await expect(
              isLaunchAgentEnabled({ env: { HOME: tempDir }, timeoutMs: 100 }),
            ).rejects.toThrow("launchctl print-disabled failed");
          } else {
            const runtime = await readLaunchAgentRuntime({ HOME: tempDir }, { timeoutMs: 100 });
            expect(runtime.status).toBe("unknown");
          }
          expect(Date.now() - startedAt).toBeLessThan(1_000);
        });
      } finally {
        state.realExecFile = false;
        await realFs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  const inspectionFailure = (detail: string) => ({
    status: "unknown",
    detail,
    inspectionReason: "launchd-gui-domain-unavailable",
  });
  it.each([
    [
      "installed but unloaded",
      true,
      true,
      'Bad request.\nCould not find service "ai.openclaw.gateway" in domain for user gui: 501',
      { status: "stopped" },
    ],
    [
      "missing GUI session",
      true,
      true,
      GUI_UNAVAILABLE,
      { ...inspectionFailure(GUI_UNAVAILABLE), missingGuiSession: true },
    ],
    [
      "unexpected inspection failure",
      true,
      true,
      "Operation not permitted\nwhile reading launchd state",
      inspectionFailure("Operation not permitted while reading launchd state"),
    ],
    ["missing job and plist", false, false, "", { status: "unknown", missingUnit: true }],
    [
      "system ownership even with a loaded user job",
      false,
      true,
      "",
      {
        status: "unknown",
        detail: "System LaunchDaemon system/ai.openclaw.gateway already owns this gateway label.",
        inspectionReason: "launchd-system-owned",
        systemLaunchDaemon: { status: "loaded", serviceTarget: "system/ai.openclaw.gateway" },
      },
    ],
  ] as const)("reports %s", async (_name, installed, loaded, error, expected) => {
    if (installed) {
      state.files.set(resolveLaunchAgentPlistPath(ENV), "<plist/>");
    }
    state.serviceLoaded = loaded;
    state.printError = error;
    state.printFailuresRemaining = error ? 1 : 0;
    if (!installed && loaded) {
      launchdSystemState.inspectSystemLaunchDaemonOwnership.mockResolvedValueOnce({
        status: "loaded",
        serviceTarget: "system/ai.openclaw.gateway",
      });
    }
    await expect(readLaunchAgentRuntime(ENV)).resolves.toEqual(expected);
    expect(launchdSystemState.inspectSystemLaunchDaemonOwnership).toHaveBeenCalledWith(
      "ai.openclaw.gateway",
      { scanInstalledPlists: false },
    );
  });
});

describe("launchctl list detection", () => {
  it("discovers stale OpenClaw updater jobs from launchctl list", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    state.listOutput = [
      "123 0 ai.openclaw.gateway",
      "- 127 ai.openclaw.update.2026.5.12",
      "- 0 ai.openclaw.manual-update.1717168800",
      "8142 0 ai.openclaw.update.2026.5.13-beta.1",
      "915 0 ai.openclaw.tayoun.update.20260625T201026-0400",
      "- 0 ai.openclaw.manual-updater.1717168800",
      "- 0 com.example.other",
    ].join("\n");
    const jobs = await findStaleOpenClawUpdateLaunchdJobs(ENV);

    expect(jobs).toEqual([
      { label: "ai.openclaw.manual-update.1717168800", lastExitStatus: 0 },
      { label: "ai.openclaw.update.2026.5.12", lastExitStatus: 127 },
      { label: "ai.openclaw.update.2026.5.13-beta.1", pid: 8142, lastExitStatus: 0 },
    ]);
  });

  const updater = "ai.openclaw.update.2026.5.12";
  const profileUpdater = "ai.openclaw.tayoun.update.20260625T201026-0400";
  const gateway = "ai.openclaw.dev.team.update.20260625T201026-0400";
  const envFile = `/Users/test/.openclaw-tayoun/service-env/${profileUpdater}.env`;
  const wrapper = `/Users/test/.openclaw-tayoun/service-env/${profileUpdater}-env-wrapper.sh`;
  const updateArgs = ["/opt/homebrew/bin/openclaw", "update", "--yes"];
  const gatewayArgs = ["/opt/homebrew/bin/openclaw", "gateway", "run"];
  const fakeUpdater = "ai.openclaw.fake.update.20260625T201026-0400";
  const helperUpdater = "ai.openclaw.helper.update.20260625T201026-0400";
  const manualUpdater = "ai.openclaw.manual-update.1717168800";
  const acceptedProfile = [{ label: profileUpdater, pid: 4321, lastExitStatus: 0 }];
  const nativeProfile = { ...ENV, LAUNCH_JOB_LABEL: profileUpdater };
  const configuredUpdater = { XPC_SERVICE_NAME: "0", OPENCLAW_LAUNCHD_LABEL: updater };
  const gatewayProfile = { LAUNCH_JOB_LABEL: updater, OPENCLAW_PROFILE: "update.2026.5.12" };
  const handoffEnv = { ...ENV, OPENCLAW_UPDATE_RUN_HANDOFF: "1" };
  const nodeUpdateArgs = ["/usr/local/bin/node", "/opt/openclaw/openclaw.mjs", "update", "--yes"];
  const gatewayMarker = {
    LAUNCH_JOB_LABEL: updater,
    OPENCLAW_LAUNCHD_LABEL: updater,
    OPENCLAW_SERVICE_MARKER: "openclaw",
    OPENCLAW_SERVICE_KIND: "gateway",
  };
  type ScanJob = [label: string, pid: number | undefined, args?: string[]];
  function scanCase(
    name: string,
    jobs: ScanJob[],
    expected: { label: string; pid?: number; lastExitStatus: number }[],
    env: NodeJS.ProcessEnv = ENV,
    generatedMarker = false,
  ) {
    return { name, jobs, expected, env, generatedMarker };
  }
  it.runIf(process.platform === "darwin").each([
    scanCase(
      "profile commands require an OpenClaw update command",
      [
        [profileUpdater, 4321, [...updateArgs, "--json"]],
        [gateway, 9876, gatewayArgs],
        [fakeUpdater, 2468, ["/bin/echo", "update", "--yes"]],
        [helperUpdater, 1357, ["/usr/local/bin/openclaw-helper", "update", "--yes"]],
      ],
      acceptedProfile,
    ),
    scanCase(
      "generated environment marker confirms an updater",
      [[profileUpdater, 4321, [LAUNCH_AGENT_ENV_WRAPPER_SHELL, wrapper, envFile, ...gatewayArgs]]],
      acceptedProfile,
      ENV,
      true,
    ),
    scanCase("scanner marker cannot confirm a different job", [[gateway, 9876, gatewayArgs]], [], {
      ...ENV,
      OPENCLAW_UPDATE_RUN_HANDOFF: "1",
    }),
    scanCase(
      "current gateway labels cannot become stale update jobs",
      [
        [manualUpdater, undefined],
        ["ai.openclaw.manual-update.profile", 812],
        ["ai.openclaw.manual-update.custom-label", 913],
      ],
      [{ label: manualUpdater, lastExitStatus: 0 }],
      {
        OPENCLAW_PROFILE: "manual-update.profile",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.custom-label",
        OPENCLAW_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
        OPENCLAW_SERVICE_KIND: GATEWAY_SERVICE_KIND,
      },
    ),
  ])(
    "discovers only confirmed stale jobs: $name",
    async ({ env, jobs, generatedMarker, expected }) => {
      state.listOutput = jobs.map(([label, pid]) => `${pid ?? "-"} 0 ${label}`).join("\n");
      for (const [label, , args] of jobs) {
        if (args) {
          setLaunchAgentPlist(env, label, args);
        }
      }
      if (generatedMarker) {
        state.files.set(envFile, "export OPENCLAW_UPDATE_RUN_HANDOFF='1'\n");
      }
      await expect(findStaleOpenClawUpdateLaunchdJobs(env)).resolves.toEqual(expected);
    },
  );
  it
    .runIf(process.platform === "darwin")
    .each<[name: string, env: NodeJS.ProcessEnv, args: string[] | undefined, disabled: boolean]>([
      ["native label", { LAUNCH_JOB_LABEL: updater }, undefined, true],
      ["configured updater", configuredUpdater, undefined, true],
      ["gateway profile", gatewayProfile, undefined, false],
      ["gateway marker", gatewayMarker, undefined, false],
      ["profile Node command", nativeProfile, nodeUpdateArgs, true],
      [
        "native handoff marker",
        { ...nativeProfile, OPENCLAW_UPDATE_RUN_HANDOFF: "1" },
        undefined,
        true,
      ],
      [
        "unconfirmed configured handoff",
        { ...handoffEnv, OPENCLAW_LAUNCHD_LABEL: gateway },
        gatewayArgs,
        false,
      ],
      [
        "confirmed configured handoff",
        { ...handoffEnv, OPENCLAW_LAUNCHD_LABEL: profileUpdater },
        updateArgs,
        true,
      ],
      ["unconfirmed profile gateway", nativeProfile, gatewayArgs, false],
    ])("disarms only confirmed updater jobs: %s", async (_name, env, args, disabled) => {
    const label = expectDefined(
      env.LAUNCH_JOB_LABEL ?? env.OPENCLAW_LAUNCHD_LABEL,
      "updater label",
    );
    if (args) {
      setLaunchAgentPlist(ENV, label, args);
    }
    await expect(disableCurrentOpenClawUpdateLaunchdJob(env)).resolves.toBe(disabled);
    if (disabled) {
      expect(state.launchctlCalls).toContainEqual(["disable", `${DOMAIN}/${label}`]);
      expect(state.launchctlCalls.map(([command]) => command)).not.toContain("remove");
    } else {
      expect(state.launchctlCalls).toEqual([]);
    }
  });
});

it("does not park an external LaunchAgent", async () => {
  await withEnvAsync(EXTERNAL_PROCESS, async () => {
    using _ = vi.spyOn(process, "env", "get").mockReturnValue(ENV);
    await expect(parkCurrentLaunchAgentForMaintenance()).resolves.toBe(false);
  });

  expectServiceCalls("print");
  expect(getSelfAndAncestorPidsSync).toHaveBeenCalledOnce();
  expect(park).not.toHaveBeenCalled();
});

describe("launchd process ancestry guards", () => {
  const markService = (label = "ai.openclaw.gateway", xpc = "0") => {
    for (const [key, value] of Object.entries({
      XPC_SERVICE_NAME: xpc,
      OPENCLAW_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
      OPENCLAW_SERVICE_KIND: GATEWAY_SERVICE_KIND,
      OPENCLAW_LAUNCHD_LABEL: label,
    })) {
      vi.stubEnv(key, value);
    }
  };
  beforeEach(() => {
    for (const key of Object.keys(EXTERNAL_PROCESS)) {
      vi.stubEnv(key, undefined);
    }
  });
  const installOrUninstall = (action: "install" | "uninstall") =>
    action === "install" ? install() : uninstallLaunchAgent(control());
  it.each([
    { action: "install", native: false },
    { action: "uninstall", native: false },
    { action: "install", native: true },
    { action: "uninstall", native: true },
  ] as const)(
    "allows external $action with inherited service markers (native: $native)",
    async ({ action, native }) => {
      setGatewayPlist();
      markService("ai.openclaw.gateway", native ? "ai.openclaw.gateway" : "0");
      await expect(installOrUninstall(action)).resolves.not.toThrow();
      expect(getSelfAndAncestorPidsSync).toHaveBeenCalled();
    },
  );

  it.each([
    ["a Gateway ancestor", true, 4242, false],
    ["a marked Gateway ancestor", true, 4242, true],
    ["an external caller", false, 4242, false],
    ["a service PID matching the host PID", false, process.pid, false],
    ["a service PID matching the host parent PID", false, process.ppid, false],
  ] as const)("restarts with %s", async (_name, inside, servicePid, marked) => {
    if (marked) {
      markService();
    }
    state.printOutput = ["state = running", `pid = ${servicePid}`].join("\n");
    if (inside) {
      getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));
    }

    const result = await restartLaunchAgent(control());

    expect(getSelfAndAncestorPidsSync).toHaveBeenCalledOnce();
    if (inside) {
      expect(result).toEqual({ outcome: "scheduled" });
      expect(handoff).toHaveBeenCalledWith({
        env: ENV,
        mode: "kickstart",
        waitForPid: process.pid,
      });
      expectServiceCalls("print");
      expect(cleanStaleGatewayProcessesSync).not.toHaveBeenCalled();
    } else {
      expect(result).toEqual({ outcome: "completed" });
      expect(handoff).not.toHaveBeenCalled();
      expectServiceCalls("print", "enable", ["kickstart", "-k"]);
    }
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
  ] as const)(
    "refuses stop with a Gateway ancestor (disable: %s, marked: %s)",
    async (disable, marked) => {
      if (marked) {
        markService();
      }
      getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));

      await expect(stopLaunchAgent(control({ disable }))).rejects.toThrow(
        "Refusing to stop LaunchAgent ai.openclaw.gateway from inside the same launchd service",
      );

      expectServiceCalls("print");
    },
  );

  it("parks without env markers when the Gateway is an ancestor", async () => {
    getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));

    using _ = vi.spyOn(process, "env", "get").mockReturnValue(ENV);
    await expect(parkCurrentLaunchAgentForMaintenance()).resolves.toBe(true);

    expectServiceCalls("print", "disable");
    expect(park).toHaveBeenCalledWith({
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
      expectServiceCalls("print");
    },
  );

  it.each([false, true])(
    "refuses legacy Gateway install after probing target first (marked: %s)",
    async (marked) => {
      const legacyServiceId = `${DOMAIN}/ai.openclaw.legacy-gateway`;
      state.serviceStates.set(SERVICE_ID, "not-loaded");
      state.serviceStates.set(legacyServiceId, "running");
      getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));

      if (marked) {
        markService("ai.openclaw.legacy-gateway");
      } else {
        vi.stubEnv("OPENCLAW_LAUNCHD_LABEL", "ai.openclaw.legacy-gateway");
      }
      await expect(install()).rejects.toThrow(
        "Refusing to install LaunchAgent ai.openclaw.gateway from inside ai.openclaw.legacy-gateway",
      );

      expect(state.fileWrites).toEqual([]);
      expect(state.launchctlCalls).toEqual([
        ["print", SERVICE_ID],
        ["print", legacyServiceId],
      ]);
      expect(getSelfAndAncestorPidsSync).toHaveBeenCalledOnce();
    },
  );
});

describe("LaunchAgent service membership", () => {
  beforeEach(() => vi.stubEnv("LAUNCH_JOB_LABEL", "ai.openclaw.gateway"));
  const restart = () => restartLaunchAgent(control());
  it("restarts from a verified external terminal with unreadable ancestors", async () => {
    getSelfAndAncestorPidsSync.mockReturnValue(new Set(launchdCallerPids));

    await expect(restart()).resolves.toEqual({ outcome: "completed" });
    expectServiceCalls(["print"], ["enable"], ["kickstart", "-k"]);
    expect(handoff).not.toHaveBeenCalled();
  });

  it.each([
    ["synchronous", { ok: false, error: "spawn failed" }, "spawn failed"],
    ["asynchronous", { ok: true, value: Promise.resolve(false) }, "helper failed to spawn"],
  ] as const)("surfaces %s detached handoff failures", async (_failure, result, reason) => {
    const stdout = new PassThrough();
    const onMutation = vi.fn();
    nativeServiceMembership.mockReturnValue("inside");
    handoff.mockReturnValue(result);

    await expect(restartLaunchAgent({ env: ENV, stdout, onMutation })).rejects.toThrow(
      `launchd restart handoff failed: ${reason}`,
    );
    expect(onMutation).not.toHaveBeenCalled();
    expect(stdout.read()?.toString() ?? "").not.toContain("Scheduled LaunchAgent restart");
  });

  it.each([
    { action: "install", membership: "inside" },
    { action: "install", membership: "unknown" },
    { action: "uninstall", membership: "ancestor" },
  ] as const)(
    "refuses $action before mutation with $membership service membership",
    async ({ action, membership }) => {
      state.serviceStates.set(SERVICE_ID, "running");
      getSelfAndAncestorPidsSync.mockReturnValue(
        new Set([...launchdCallerPids, membership === "ancestor" ? 4242 : 1]),
      );
      if (membership !== "ancestor") {
        nativeServiceMembership.mockReturnValue(membership);
      }
      const previous = setGatewayPlist();
      const args = defaultLaunchAgentFixture(ENV);
      await expect(
        action === "install" ? installLaunchAgent(args) : uninstallLaunchAgent(args),
      ).rejects.toThrow(
        membership === "unknown"
          ? "Native Gateway service membership could not be verified"
          : `Refusing to ${action} LaunchAgent ai.openclaw.gateway from inside ai.openclaw.gateway`,
      );
      expect(state.fileWrites).toEqual([]);
      expect(state.files.get(resolveLaunchAgentPlistPath(ENV))).toBe(previous);
      expectServiceCalls(["print"]);
    },
  );

  it("re-enables the LaunchAgent when the maintenance handoff cannot spawn", async () => {
    getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));
    state.disableCode = 0;
    park.mockReturnValueOnce({
      ok: true,
      value: Promise.resolve(false),
    });

    using _ = vi.spyOn(process, "env", "get").mockReturnValue(ENV);
    await expect(parkCurrentLaunchAgentForMaintenance()).rejects.toThrow(
      "helper failed to spawn; restored launchd enable state",
    );
    expectServiceCalls(["print"], ["disable"], ["enable"]);
  });

  it("hands plist reload off when current LaunchAgent needs rewritten paths", async () => {
    getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));
    const plistPath = resolveLaunchAgentPlistPath(ENV);
    setLegacyGatewayLaunchAgentPlist(plistPath, [
      "    <key>StandardOutPath</key>",
      "    <string>/Users/test/.openclaw-default/logs/gateway.log</string>",
    ]);

    await expect(restart()).resolves.toEqual({ outcome: "scheduled" });
    expect(handoff).toHaveBeenCalledWith({
      env: ENV,
      mode: "reload",
      waitForPid: process.pid,
    });
    expect(state.files.get(plistPath)).toContain("/Users/test/Library/Logs/openclaw/gateway.log");
    expectServiceCalls(["print"]);
  });
});
