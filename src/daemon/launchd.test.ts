await vi.hoisted(() => import("./launchd-ancestry.test-support.js"));
import "./launchd-fs.mocks.test-support.js";
import fs from "node:fs/promises";
import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../../test/vitest/vitest.timeouts.js";
import type { PortListener } from "../infra/ports-types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { GATEWAY_SERVICE_KIND, GATEWAY_SERVICE_MARKER } from "./constants.js";
import {
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
} from "./launchd-ancestry.test-support.js";
import * as launchdExec from "./launchd-exec.js";
import {
  capturePassThroughOutput,
  createDefaultLaunchdEnv,
  createLaunchdEnvWithGatewayPort,
  createTestLaunchAgentPlist,
  defaultLaunchAgentFixture,
  launchAgentControlFixture,
  defaultProgramArguments,
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
  readLaunchAgentProgramArguments,
  readLaunchAgentRuntime,
  repairLaunchAgentBootstrap,
  restartLaunchAgent,
  resolveLaunchAgentPlistPath,
  stageLaunchAgent,
  startLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";

const ENV = createDefaultLaunchdEnv();
const DOMAIN = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
const SERVICE_ID = `${DOMAIN}/ai.openclaw.gateway`;
const ENV_FILE = "/Users/test/.openclaw/service-env/ai.openclaw.gateway.env";
const WRAPPER = "/Users/test/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh";
const PLIST = resolveLaunchAgentPlistPath(ENV);
const PREVIOUS_ARGS = ["/previous/node", "/previous/openclaw.mjs", "gateway"];
const WRAPPED_ARGS = [
  LAUNCH_AGENT_ENV_WRAPPER_SHELL,
  WRAPPER,
  ENV_FILE,
  ...defaultProgramArguments,
];
const GUI_UNAVAILABLE = "Bootstrap failed: 125: Domain does not support specified action";
const BOOTSTRAP_EXISTS =
  "Could not bootstrap service: 5: Input/output error: already exists in domain for gui/501";
const BOOTSTRAP_PROGRESS = "Bootstrap failed: 37: Operation already in progress";
const SERVICE_MARKERS = {
  XPC_SERVICE_NAME: "0",
  OPENCLAW_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
  OPENCLAW_SERVICE_KIND: GATEWAY_SERVICE_KIND,
  OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
};

function install(overrides?: Parameters<typeof defaultLaunchAgentFixture>[1]) {
  return installLaunchAgent(defaultLaunchAgentFixture(ENV, overrides));
}

function control(overrides?: Parameters<typeof launchAgentControlFixture>[1]) {
  return launchAgentControlFixture(ENV, overrides);
}

function expectCommands(commands: string) {
  expect(launchctlCommandNames()).toEqual(commands ? commands.split(" ") : []);
}

function expectServiceCalls(...commands: (string | string[])[]) {
  expect(state.launchctlCalls).toEqual(
    commands.map((command) =>
      typeof command === "string" ? [command, SERVICE_ID] : command.concat(SERVICE_ID),
    ),
  );
}

function expectProtectedCleanup(port: number) {
  expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(
    port,
    expect.objectContaining({ resolveProtectedPid: expect.any(Function) }),
  );
}

function expectArtifacts(...artifacts: [string, string | undefined, number][]) {
  for (const [path, contents, mode] of artifacts) {
    expect({ contents: state.files.get(path), mode: state.fileModes.get(path) }).toEqual({
      contents,
      mode,
    });
  }
}

function setArtifact(path: string, contents: string, mode: number) {
  state.files.set(path, contents);
  state.fileModes.set(path, mode);
}

const EXTERNAL_PROCESS = {
  LAUNCH_JOB_LABEL: undefined,
  LAUNCH_JOB_NAME: undefined,
  XPC_SERVICE_NAME: undefined,
  OPENCLAW_SERVICE_MARKER: undefined,
  OPENCLAW_SERVICE_KIND: undefined,
  OPENCLAW_LAUNCHD_LABEL: undefined,
};

function readPlistProgramArgumentStrings(plist: string): string[] {
  const match = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/i);
  return Array.from((match?.[1] ?? "").matchAll(/<string>([\s\S]*?)<\/string>/gi)).map(
    (item) => item[1] ?? "",
  );
}

function setLaunchAgentPlist(
  env: Record<string, string | undefined>,
  label: string,
  programArguments: string[],
  environment?: Record<string, string>,
): string {
  const plist = createTestLaunchAgentPlist({ label, programArguments, environment });
  state.files.set(`${env.HOME}/Library/LaunchAgents/${label}.plist`, plist);
  return plist;
}

function setGatewayPlist(
  programArguments = defaultProgramArguments,
  environment?: Record<string, string>,
) {
  return setLaunchAgentPlist(ENV, "ai.openclaw.gateway", programArguments, environment);
}

function captureOutput(encoding?: BufferEncoding) {
  let output = "";
  return {
    stdout: capturePassThroughOutput((text) => (output += text), encoding),
    text: () => output,
  };
}

function mockPort(port: number, status: "free" | "busy", listeners: PortListener[] = []) {
  inspectPortUsage.mockResolvedValue({ port, status, listeners, hints: [] });
}

async function runWithFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    let settled = false;
    const pending = run()
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }))
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(
      async () => {
        await vi.runAllTimersAsync();
        expect(settled).toBe(true);
      },
      { timeout: DEFAULT_VITEST_TEST_TIMEOUT_MS - 1000 },
    );
    const result = await pending;
    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  } finally {
    vi.useRealTimers();
  }
}

function expectLaunchctlEnableBootstrapOrder() {
  const enableIndex = state.launchctlCalls.findIndex(
    (c) => c[0] === "enable" && c[1] === SERVICE_ID,
  );
  const bootstrapIndex = state.launchctlCalls.findIndex(
    (c) => c[0] === "bootstrap" && c[1] === DOMAIN && c[2] === PLIST,
  );

  expect(enableIndex).toBeGreaterThanOrEqual(0);
  expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
  expect(enableIndex).toBeLessThan(bootstrapIndex);
}

function launchctlCommandNames(): string[] {
  return state.launchctlCalls.map(([command]) => command ?? "");
}

function createSystemOwnershipError(
  status: "loaded" | "installed" | "unverifiable" = "loaded",
): Error {
  const details = {
    installed: { plistPath: "/Library/LaunchDaemons/custom-openclaw.plist" },
    unverifiable: { operation: "launchctl", detail: "permission denied" },
    loaded: {},
  };
  return Object.assign(new Error(`system ownership blocked: ${status}`), {
    code: "SYSTEM_LAUNCH_DAEMON_OWNERSHIP",
    ownership: { status, serviceTarget: "system/ai.openclaw.gateway", ...details[status] },
  });
}

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
  const handoff = { ...ENV, OPENCLAW_UPDATE_RUN_HANDOFF: "1" };
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
        { ...handoff, OPENCLAW_LAUNCHD_LABEL: gateway },
        gatewayArgs,
        false,
      ],
      [
        "confirmed configured handoff",
        { ...handoff, OPENCLAW_LAUNCHD_LABEL: profileUpdater },
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
      expect(launchctlCommandNames()).not.toContain("remove");
    } else {
      expect(state.launchctlCalls).toEqual([]);
    }
  });
});

describe("launchd bootstrap repair", () => {
  it.each([
    ["loaded", "system-launchdaemon-conflict"],
    ["unverifiable", "system-launchdaemon-unverifiable"],
  ] as const)(
    "returns typed %s system ownership failures before rewriting",
    async (status, expected) => {
      launchdSystemState.assertNoSystemLaunchDaemonOwnership.mockRejectedValueOnce(
        createSystemOwnershipError(status),
      );

      const repair = await repairLaunchAgentBootstrap({ env: ENV });

      expect(repair).toEqual({
        ok: false,
        status: expected,
        detail: `system ownership blocked: ${status}`,
      });
      expect(state.fileWrites).toEqual([]);
      expect(state.launchctlCalls).toEqual([]);
    },
  );

  it("migrates inline secrets before making an existing plist readable", async () => {
    const warn = vi.fn();
    const secret = "legacy-secret";
    state.files.set(WRAPPER, "custom wrapper");
    setGatewayPlist(defaultProgramArguments, { OPENAI_API_KEY: secret });
    state.fileModes.set(PLIST, 0o600);

    await expect(repairLaunchAgentBootstrap({ env: ENV, warn })).resolves.toEqual({
      ok: true,
      status: "repaired",
    });
    expectLaunchctlEnableBootstrapOrder();
    expect(launchctlCommandNames()).not.toContain("kickstart");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("custom behavior"));
    expect(state.files.get(PLIST)).not.toContain(secret);
    expect(state.fileModes.get(PLIST)).toBe(0o644);
    expect(state.files.get(ENV_FILE)).toContain(secret);
  });

  const repaired = { ok: true, status: "already-loaded" } as const;
  const missingDomain = "Could not find domain for user gui: 999999";
  const kickstartDenied = "launchctl kickstart failed: permission denied";
  function repairCase(
    name: string,
    detail: string,
    expected: Awaited<ReturnType<typeof repairLaunchAgentBootstrap>>,
    overrides: Partial<typeof state> = {},
  ) {
    return { name, detail, expected, overrides };
  }
  it.each([
    repairCase("operation already in progress with loaded job", BOOTSTRAP_PROGRESS, repaired, {
      bootstrapCode: 37,
    }),
    repairCase("exit", BOOTSTRAP_EXISTS, repaired, { serviceRunning: false }),
    repairCase(
      "timeout",
      BOOTSTRAP_EXISTS,
      { ok: false, status: "bootstrap-failed", detail: BOOTSTRAP_EXISTS },
      { bootstrapTermination: "timeout", serviceRunning: false },
    ),
    repairCase("missing GUI domain", missingDomain, {
      ok: false,
      status: "gui-session-unavailable",
      detail: missingDomain,
      domain: DOMAIN,
    }),
    repairCase(
      "failed kickstart after operation already in progress",
      BOOTSTRAP_PROGRESS,
      { ok: false, status: "kickstart-failed", detail: kickstartDenied },
      {
        bootstrapCode: 37,
        serviceRunning: false,
        kickstartError: kickstartDenied,
        kickstartFailuresRemaining: 1,
      },
    ),
  ])("classifies bootstrap repair: $name", async ({ detail, expected, overrides }) => {
    Object.assign(state, { bootstrapError: detail }, overrides);
    const needsKickstart = !state.serviceRunning && state.bootstrapTermination === "exit";
    await expect(repairLaunchAgentBootstrap({ env: ENV })).resolves.toEqual(expected);
    expectLaunchctlEnableBootstrapOrder();
    expect(state.launchctlCalls.filter((call) => call[0] === "kickstart")).toEqual(
      needsKickstart ? [["kickstart", SERVICE_ID]] : [],
    );
  });
});

describe("launchd uninstall", () => {
  it.each([
    { operation: "lstat", code: "EACCES" },
    { operation: "rename", code: "ENOENT" },
  ] as const)(
    "reports $operation $code without leaking the plist path",
    async ({ operation, code }) => {
      if (operation === "rename") {
        state.files.set(PLIST, "RunAtLoad=true");
      }
      vi.mocked(fs[operation]).mockRejectedValueOnce(
        Object.assign(new Error(`${code}: ${operation} '${PLIST}'`), { code }),
      );
      const uninstall = uninstallLaunchAgent(control());
      await expect(uninstall).rejects.toThrow(`LaunchAgent removal failed (${code})`);
      await expect(uninstall).rejects.not.toThrow(PLIST);
      if (operation === "rename") {
        expect(state.files.has(PLIST)).toBe(true);
      }
    },
  );

  it("preserves the plist when launchctl cannot boot out the service", async () => {
    state.files.set(PLIST, "RunAtLoad=true");
    state.bootoutError = "launchctl bootout permission denied";

    await expect(uninstallLaunchAgent(control())).rejects.toThrow(
      "launchctl bootout failed: launchctl bootout permission denied",
    );
    expect(state.files.has(PLIST)).toBe(true);
  });

  it.each(["missing", "stopped symlink", "concurrently removed"])(
    "keeps removal idempotent for a %s LaunchAgent",
    async (kind) => {
      if (kind !== "missing") {
        state.files.set(PLIST, "RunAtLoad=true");
      }
      if (kind === "stopped symlink") {
        state.serviceLoaded = false;
        state.bootoutError = "Boot-out failed: 5: Input/output error";
      }
      if (kind === "concurrently removed") {
        vi.mocked(fs.rename).mockImplementationOnce(async () => {
          state.files.delete(PLIST);
          throw Object.assign(new Error(`ENOENT: no such file, rename '${PLIST}'`), {
            code: "ENOENT",
          });
        });
      }
      await expect(uninstallLaunchAgent(control())).resolves.toBeUndefined();
      expect(state.files.has(PLIST)).toBe(false);
      if (kind === "stopped symlink") {
        expect(state.launchctlCalls.some((call) => call[0] === "bootout")).toBe(false);
      }
    },
  );
});

describe("launchd install", () => {
  it("refuses an in-band label migration before mutating either LaunchAgent", async () => {
    state.serviceStates.set(`${DOMAIN}/ai.openclaw.gateway`, "not-loaded");
    getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));

    await withEnvAsync(
      { ...SERVICE_MARKERS, OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.legacy-gateway" },
      async () => {
        await expect(install()).rejects.toThrow(
          "Refusing to install LaunchAgent ai.openclaw.gateway from inside ai.openclaw.legacy-gateway",
        );
      },
    );

    expect(state.fileWrites).toEqual([]);
    expect(state.launchctlCalls).toEqual([
      ["print", `${DOMAIN}/ai.openclaw.gateway`],
      ["print", `${DOMAIN}/ai.openclaw.legacy-gateway`],
    ]);
  });

  it("stages a canonical plist without retiring a legacy LaunchAgent", async () => {
    const legacyLabel = "ai.openclaw.legacy-gateway";
    const legacyPlistPath = `${ENV.HOME}/Library/LaunchAgents/${legacyLabel}.plist`;
    const previousLegacy = setLaunchAgentPlist(ENV, legacyLabel, [
      "/legacy/node",
      "/legacy/openclaw.mjs",
      "gateway",
    ]);

    await stageLaunchAgent(defaultLaunchAgentFixture(ENV));

    expect(state.files.get(legacyPlistPath)).toBe(previousLegacy);
    expect(state.files.has(resolveLaunchAgentPlistPath(ENV))).toBe(true);
    expect(state.launchctlCalls).toEqual([]);
  });

  it.each(["ambiguous supervision", "missing loaded definition"] as const)(
    "aborts before mutation with %s",
    async (scenario) => {
      const previous =
        scenario === "ambiguous supervision" ? setGatewayPlist(PREVIOUS_ARGS) : undefined;
      if (scenario === "ambiguous supervision") {
        state.printError = "launchctl print permission denied";
        // A denied membership probe must refuse before any native mutation.
        state.printFailuresRemaining = 2;
      } else {
        state.serviceStates.set(`${DOMAIN}/ai.openclaw.gateway`, "running");
      }

      const operation = install();
      if (scenario === "ambiguous supervision") {
        await expect(operation).rejects.toMatchObject({ reason: "service-membership-unverified" });
      } else {
        await expect(operation).rejects.toThrow("is loaded but its plist is missing");
        expect(state).toMatchObject({ serviceLoaded: true, serviceRunning: true });
      }

      expect(state.files.get(PLIST)).toBe(previous);
      expect(state.fileWrites).toEqual([]);
      expect(launchctlCommandNames()).toEqual(
        scenario === "ambiguous supervision" ? ["print"] : ["print", "print"],
      );
    },
  );

  it("restores absent artifacts after a failed fresh install", async () => {
    state.serviceLoaded = false;
    state.serviceRunning = false;
    state.bootstrapError = "Operation not permitted";
    state.bootstrapTransient = true;
    state.bootoutError = "Boot-out failed: 5: Input/output error";
    state.bootoutCode = 5;
    const operation = install({ environment: { OPENCLAW_GATEWAY_PORT: "19000" } });
    await expect(operation).rejects.toThrow("launchctl bootstrap failed: Operation not permitted");
    await expect(operation).rejects.toBeInstanceOf(Error);
    await expect(operation).rejects.toMatchObject({
      message: "launchctl bootstrap failed: Operation not permitted",
    });
    expect(state.files.has(PLIST)).toBe(false);
    expect(state.files.has(ENV_FILE)).toBe(false);
    expect(state.files.has(WRAPPER)).toBe(false);
    expectCommands("print print enable bootstrap print");
  });

  it("fails closed when rollback cannot determine the replacement state", async () => {
    // Membership and the prior snapshot see absence; rollback sees the error.
    state.printNotLoadedRemaining = 2;
    state.printError = "launchctl print permission denied";
    state.printFailuresRemaining = 1;
    state.bootstrapError = "Operation not permitted";

    const error = await install().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("launchctl bootstrap failed: Operation not permitted"),
      }),
      expect.objectContaining({ message: expect.stringContaining("could not determine whether") }),
    ]);
    expect(state.files.has(PLIST)).toBe(true);
    expectCommands("print print enable bootstrap print");
  });

  it("restores prior supervision and private artifacts without changing enabled policy", async () => {
    const previousEnv = "export OPENCLAW_GATEWAY_PORT='18789'\n";
    const previousWrapper = '#!/bin/sh\n. "$1"\nshift\nexec "$@"\n';
    const previous = setGatewayPlist(["/bin/sh", WRAPPER, ENV_FILE, ...PREVIOUS_ARGS]);
    setArtifact(PLIST, previous, 0o600);
    setArtifact(ENV_FILE, previousEnv, 0o600);
    setArtifact(WRAPPER, previousWrapper, 0o700);
    state.bootstrapError = "Operation not permitted";
    state.bootstrapTransient = true;

    await expect(
      install({ preserveAutoStart: true, environment: { OPENCLAW_GATEWAY_PORT: "19000" } }),
    ).rejects.toThrow("launchctl bootstrap failed: Operation not permitted");

    expectArtifacts(
      [PLIST, previous, 0o600],
      [ENV_FILE, previousEnv, 0o600],
      [WRAPPER, previousWrapper, 0o700],
    );
    expect(state).toMatchObject({ serviceLoaded: true, serviceRunning: true });
    expectCommands("print print-disabled print bootout unload bootstrap print bootstrap");
  });

  it("preserves disabled policy and supervision after bootstrap failure", async () => {
    const previous = setGatewayPlist(PREVIOUS_ARGS);
    state.fileModes.set(PLIST, 0o600);
    state.printDisabledOutput = 'disabled services = {\n\t"ai.openclaw.gateway" => disabled\n}';
    state.bootstrapError = "injected activation failure";
    state.bootstrapTransient = true;
    const operation = install({ preserveAutoStart: true });
    await expect(operation).rejects.toThrow("injected activation failure");
    expect(state.files.get(PLIST)).toBe(previous);
    expect(state).toMatchObject({ serviceLoaded: true, serviceRunning: true });
    expect(await isLaunchAgentEnabled({ env: ENV })).toBe(false);
    expect(
      launchctlCommandNames().filter((command) =>
        ["enable", "bootstrap", "disable"].includes(command),
      ),
    ).toEqual(["enable", "bootstrap", "disable", "enable", "bootstrap", "disable"]);
  });
  it.each(["install", "restart"] as const)(
    "refuses %s before user LaunchAgent mutation when a system daemon owns it",
    async (action) => {
      launchdSystemState.assertNoSystemLaunchDaemonOwnership.mockRejectedValue(
        createSystemOwnershipError(),
      );
      const args = defaultLaunchAgentFixture(ENV);
      const operations = {
        install: installLaunchAgent,
        restart: restartLaunchAgent,
      };
      await expect(operations[action](args)).rejects.toThrow("system ownership blocked: loaded");
      expect(state.fileWrites).toEqual([]);
      expect(launchctlCommandNames()).toEqual(action === "install" ? ["print", "print"] : []);
      expect(
        launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff,
      ).not.toHaveBeenCalled();
    },
  );

  it("rolls back a post-publication ownership race before activation", async () => {
    launchdSystemState.assertNoSystemLaunchDaemonOwnership.mockImplementation(async () => {
      if (state.files.has(resolveLaunchAgentPlistPath(ENV))) {
        throw createSystemOwnershipError("installed");
      }
    });

    await expect(install()).rejects.toThrow("system ownership blocked: installed");

    expect(state.files.has(resolveLaunchAgentPlistPath(ENV))).toBe(false);
    expectCommands("print print");
  });

  it("restores the previous plist when staged publication loses ownership", async () => {
    const previous =
      "<plist><dict><key>Label</key><string>previous</string><key>EnvironmentVariables</key><dict><key>SYNTHETIC_INLINE</key><string>private fixture value</string></dict></dict></plist>";
    setArtifact(PLIST, previous, 0o600);
    launchdSystemState.assertNoSystemLaunchDaemonOwnership
      .mockResolvedValueOnce()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(createSystemOwnershipError("loaded"));

    await expect(stageLaunchAgent(defaultLaunchAgentFixture(ENV))).rejects.toThrow(
      "system ownership blocked: loaded",
    );

    expectArtifacts([PLIST, previous, 0o600]);
    expect(state.launchctlCalls).toEqual([]);
  });

  it("keeps loaded reinstall deactivation failures fatal", async () => {
    setGatewayPlist();
    state.bootoutError = "Boot-out failed: 5: Input/output error";
    state.bootoutCode = 5;

    await expect(install()).rejects.toThrow(
      "launchctl bootout failed during LaunchAgent install: Boot-out failed: 5: Input/output error",
    );

    expectCommands("print print bootout print bootout");
  });

  it("writes LaunchAgent environment to an owner-only env file when provided", async () => {
    const tmpDir = "/Users/test/.openclaw/tmp";
    const apiKey = "secret-api-key";
    await install({
      environment: { TMPDIR: tmpDir, OPENAI_API_KEY: apiKey, NODE_OPTIONS: "", UNUSED: "" },
    });

    const plist = state.files.get(PLIST) ?? "";
    const logPath = "/Users/test/Library/Logs/openclaw/gateway.log";
    // readLastGatewayErrorLine only reads stdout on darwin, so a stderr target
    // that is not the stdout log discards every pre-logger startup failure.
    expect(plist).toContain(`<key>StandardOutPath</key>\n    <string>${logPath}</string>`);
    expect(plist).toContain(`<key>StandardErrorPath</key>\n    <string>${logPath}</string>`);
    expect(plist).not.toContain("<key>StandardErrorPath</key>\n    <string>/dev/null</string>");

    expect(plist).not.toContain("<key>EnvironmentVariables</key>");
    expect(plist).not.toContain(apiKey);
    expect(readPlistProgramArgumentStrings(plist)).toEqual(WRAPPED_ARGS);
    const envFile = state.files.get(ENV_FILE) ?? "";
    expect(envFile).toContain(`export TMPDIR='${tmpDir}'`);
    expect(state.dirs.has(tmpDir)).toBe(true);
    expect(state.dirModes.get(tmpDir)).toBe(0o700);
    expect(plist).toContain("<key>Umask</key>\n    <integer>63</integer>");
    expect(envFile).toContain(`export OPENAI_API_KEY='${apiKey}'`);
    expect(envFile).toContain("export NODE_OPTIONS=''");
    expect(envFile).not.toContain("UNUSED");
    expect(state.fileModes.get(ENV_FILE)).toBe(0o600);
    expect(state.fileModes.get(WRAPPER)).toBe(0o700);
    expect(state.dirModes.get("/Users/test/.openclaw/service-env")).toBe(0o700);

    const command = await readLaunchAgentProgramArguments(ENV);
    expect(command).toMatchObject({
      programArguments: defaultProgramArguments,
      environment: { TMPDIR: tmpDir, OPENAI_API_KEY: apiKey, NODE_OPTIONS: "" },
      environmentValueSources: { TMPDIR: "file", OPENAI_API_KEY: "file" },
    });
  });

  it("retains custom Node CA trust when reinstalling a generated owner-only LaunchAgent", async () => {
    const extraCaCerts = "/Users/test/certs/corporate-ca.pem";
    await install({
      environment: { NODE_EXTRA_CA_CERTS: extraCaCerts },
    });

    const expected = {
      environment: { NODE_EXTRA_CA_CERTS: extraCaCerts },
      environmentValueSources: { NODE_EXTRA_CA_CERTS: "file" },
    };
    const installedCommand = await readLaunchAgentProgramArguments(ENV);
    expect(installedCommand).toMatchObject(expected);
    const initialEnvWrites = state.fileWrites.filter(({ path }) => path === ENV_FILE).length;

    await install({ environment: installedCommand?.environment });

    expect(await readLaunchAgentProgramArguments(ENV)).toMatchObject(expected);
    expect(state.fileWrites.filter(({ path }) => path === ENV_FILE).length).toBeGreaterThan(
      initialEnvWrites,
    );
    expect(state.files.get(ENV_FILE)).toContain(`export NODE_EXTRA_CA_CERTS='${extraCaCerts}'`);
    expect(state.files.get(resolveLaunchAgentPlistPath(ENV))).not.toContain(extraCaCerts);
    expect(state.fileModes.get(ENV_FILE)).toBe(0o600);
    expect(state.fileModes.get(WRAPPER)).toBe(0o700);
    expect(state.dirModes.get("/Users/test/.openclaw/service-env")).toBe(0o700);
  });

  it("warns before overwriting a customized generated LaunchAgent env wrapper during restart rewrite", async () => {
    await install({
      environment: { OPENCLAW_GATEWAY_PORT: "18789" },
    });
    const generatedWrapper = expectDefined(state.files.get(WRAPPER), "generated wrapper");
    state.files.set(
      WRAPPER,
      generatedWrapper.replace('exec "$@"', 'echo "custom-secret-provider-marker"\nexec "$@"'),
    );
    state.launchctlCalls.length = 0;

    const { stdout, text } = captureOutput("utf8");

    await restartLaunchAgent({ env: ENV, stdout });

    expect(text()).toContain("Warning:");
    expect(text()).toContain("contains custom behavior and will be overwritten");
    expect(text()).toContain("openclaw gateway install --wrapper <path>");
    expect(text()).toContain("OPENCLAW_WRAPPER");
    expect(state.files.get(WRAPPER)).toBe(generatedWrapper);
  });

  it.each(["legacy shell", "mangled paths"] as const)(
    "repairs generated environment wrappers on restart: %s",
    async (kind) => {
      const mangled = kind === "mangled paths";
      const callerEnv = createDefaultLaunchdEnv();
      const stateDir = "/Users/test/service-env/custom-state";
      const environment: Record<string, string> = {
        OPENCLAW_GATEWAY_PORT: mangled ? "18789" : "19007",
      };
      if (mangled) {
        environment.OPENCLAW_STATE_DIR = stateDir;
      }
      const serviceEnv = mangled ? { ...callerEnv, OPENCLAW_STATE_DIR: stateDir } : callerEnv;
      await installLaunchAgent(defaultLaunchAgentFixture(serviceEnv, { environment }));
      const artifactDir = mangled ? `${stateDir}/service-env` : "/Users/test/.openclaw/service-env";
      const envFilePath = `${artifactDir}/ai.openclaw.gateway.env`;
      const wrapperPath = `${artifactDir}/ai.openclaw.gateway-env-wrapper.sh`;
      const mangle = (name: string) => `${artifactDir}/[${name}](http:/${name})`;
      const badEnvFile = mangle("ai.openclaw.gateway.env");
      const badWrapper = mangle("ai.openclaw.gateway-env-wrapper.sh");
      const original = state.files.get(PLIST) ?? "";
      const broken = mangled
        ? original.replace(wrapperPath, badWrapper).replace(envFilePath, badEnvFile)
        : original.replace(`<string>${LAUNCH_AGENT_ENV_WRAPPER_SHELL}</string>\n      `, "");
      state.files.set(PLIST, broken);
      if (mangled) {
        expect(await readLaunchAgentProgramArguments(callerEnv)).toMatchObject({
          programArguments: defaultProgramArguments,
          environment,
          environmentValueSources: { OPENCLAW_GATEWAY_PORT: "file" },
        });
      } else {
        expect(readPlistProgramArgumentStrings(broken)).toEqual([
          WRAPPER,
          ENV_FILE,
          ...defaultProgramArguments,
        ]);
        state.launchctlCalls.length = 0;
      }
      await restartLaunchAgent(launchAgentControlFixture(callerEnv));
      const rewritten = state.files.get(PLIST) ?? "";
      expect(readPlistProgramArgumentStrings(rewritten)).toEqual(WRAPPED_ARGS);
      if (mangled) {
        expect(rewritten).not.toContain(badEnvFile);
        expect(rewritten).not.toContain(badWrapper);
        const rewrittenEnv = state.files.get(ENV_FILE) ?? "";
        expect(rewrittenEnv).toContain("export OPENCLAW_GATEWAY_PORT='18789'");
        expect(rewrittenEnv).toContain(`export OPENCLAW_STATE_DIR='${stateDir}'`);
      } else {
        expectProtectedCleanup(19007);
      }
    },
  );

  it("publishes the rewritten plist before restart bootstrap", async () => {
    state.serviceLoaded = false;
    setLegacyGatewayLaunchAgentPlist(PLIST, [
      "    <key>EnvironmentVariables</key>",
      "    <dict>",
      "      <key>OPENCLAW_SERVICE_VERSION</key>",
      "      <string>2026.4.24</string>",
      "    </dict>",
    ]);

    const execLaunchctl = launchdExec.execLaunchctl;
    using launchctl = vi.spyOn(launchdExec, "execLaunchctl");
    let plist: string | undefined;
    launchctl.mockImplementation(async (...args) => {
      if (args[0][0] === "bootstrap") {
        plist = await fs.readFile(expectDefined(args[0][2], "bootstrap plist path"), "utf8");
      }
      return await execLaunchctl(...args);
    });
    await restartLaunchAgent(control());

    const logPath = "/Users/test/Library/Logs/openclaw/gateway.log";
    expect(plist).toContain("<key>StandardInPath</key>");
    expect(plist).toContain(`<key>StandardOutPath</key>\n    <string>${logPath}</string>`);
    expect(plist).toContain(`<key>StandardErrorPath</key>\n    <string>${logPath}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>\n    <true/>");
    expect(plist).toContain("<string>node</string>");
    expect(plist).not.toContain("OPENCLAW_SERVICE_VERSION");
  });

  it("tightens writable parents without widening private directories", async () => {
    state.dirs.add("/Users/test");
    state.dirModes.set("/Users/test", 0o777);
    state.dirs.add("/Users/test/Library");
    state.dirModes.set("/Users/test/Library", 0o700);
    await installLaunchAgent(defaultLaunchAgentFixture(ENV));
    expect(state.dirModes.get("/Users/test")).toBe(0o755);
    expect(state.dirModes.get("/Users/test/Library")).toBe(0o700);
    expect(state.dirModes.get("/Users/test/Library/LaunchAgents")).toBe(0o755 & ~process.umask());
    expect(state.fileModes.get(resolveLaunchAgentPlistPath(ENV))).toBe(0o644);
  });

  it.each([
    { stateAfterBootout: "loaded without a PID", loaded: true, running: false, dead: true },
    {
      stateAfterBootout: "unloaded with original PID alive",
      loaded: false,
      running: true,
      dead: false,
    },
  ])("rejects stop success when $stateAfterBootout", async ({ loaded, running, dead }) => {
    const { stdout, text } = captureOutput();
    state.bootoutLeavesLoaded = loaded;
    state.serviceRunning = running;
    isPidDefinitelyDead.mockReturnValue(dead);

    await expect(runWithFakeTimers(() => stopLaunchAgent({ env: ENV, stdout }))).rejects.toThrow(
      "launchctl bootout gui/",
    );
    expect(text()).not.toContain("Stopped LaunchAgent");
    expect(cleanStaleGatewayProcessesSync).not.toHaveBeenCalled();
  });

  it("refuses verified stop when launchd reports running without a PID", async () => {
    state.printOutput = "state = running\n";
    await expect(stopLaunchAgent(control())).rejects.toMatchObject({
      reason: "service-membership-unverified",
    });
  });

  it("waits for both asynchronous label teardown and process exit", async () => {
    vi.useFakeTimers();
    const { stdout, text } = captureOutput();
    state.bootoutLeavesLoaded = true;
    isPidDefinitelyDead.mockReturnValue(false);
    try {
      const stopped = stopLaunchAgent({ env: createDefaultLaunchdEnv(), stdout });
      await vi.advanceTimersByTimeAsync(500);
      expect(text()).not.toContain("Stopped LaunchAgent");
      state.serviceLoaded = false;
      await vi.advanceTimersByTimeAsync(500);
      expect(text()).not.toContain("Stopped LaunchAgent");
      isPidDefinitelyDead.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(500);
      await stopped;
      expect(text()).toContain("Stopped LaunchAgent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not park an external LaunchAgent", async () => {
    await withEnvAsync(EXTERNAL_PROCESS, async () => {
      await expect(parkCurrentLaunchAgentForMaintenance({ env: ENV })).resolves.toBe(false);
    });

    expectServiceCalls("print");
    expect(getSelfAndAncestorPidsSync).toHaveBeenCalledOnce();
    expect(
      launchdRestartHandoffState.scheduleDetachedLaunchdMaintenancePark,
    ).not.toHaveBeenCalled();
  });

  it.each(["stop", "restart"] as const)(
    "protects an in-band %s when XPC_SERVICE_NAME is inherited",
    async (action) => {
      getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));
      await withEnvAsync(
        {
          ...EXTERNAL_PROCESS,
          ...SERVICE_MARKERS,
        },
        async () => {
          if (action === "stop") {
            await expect(stopLaunchAgent(control())).rejects.toThrow(
              "Refusing to stop LaunchAgent ai.openclaw.gateway from inside the same launchd service",
            );
          } else {
            await expect(restartLaunchAgent(control())).resolves.toEqual({
              outcome: "scheduled",
            });
            expect(
              launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff,
            ).toHaveBeenCalledWith({ env: ENV, mode: "kickstart", waitForPid: process.pid });
          }
        },
      );
      expectCommands("print");
    },
  );

  it.each(["free", "busy"] as const)(
    "verifies the configured non-loopback host before reporting stop success (initially %s)",
    async (portStatus) => {
      const env = createLaunchdEnvWithGatewayPort("19011");
      resolveGatewayServiceProbeHosts.mockResolvedValue(["192.0.2.40"]);
      inspectPortUsage.mockResolvedValueOnce({
        port: 19011,
        status: portStatus,
        listeners: [],
        hints: [],
      });

      probePortUsage.mockResolvedValueOnce("busy").mockResolvedValueOnce("unknown");
      const { stdout, text } = captureOutput();
      await runWithFakeTimers(() => stopLaunchAgent({ env, stdout }));
      expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(19011, {
        env,
        assertCurrent: expect.any(Function),
      });
      expect(inspectPortUsage).toHaveBeenCalledWith(19011, { probeHosts: ["192.0.2.40"] });
      if (portStatus === "busy") {
        expect(probePortUsage).toHaveBeenCalledTimes(3);
        expect(probePortUsage).toHaveBeenCalledWith(19011, ["192.0.2.40"]);
      } else {
        expect(probePortUsage).not.toHaveBeenCalled();
      }
      expect(text()).toContain("Stopped LaunchAgent");
    },
  );

  it("rejects stop success when disable fails and the gateway port stays busy", async () => {
    const port = 19008;
    const env = createLaunchdEnvWithGatewayPort(String(port));
    const { stdout, text } = captureOutput();
    const onMutation = vi.fn();
    state.disableError = "Operation not permitted";
    mockPort(port, "busy");
    probePortUsage.mockResolvedValue("busy");
    formatPortDiagnostics.mockReturnValue([`Port ${port} is held by pid 4242.`]);

    await expect(
      runWithFakeTimers(() => stopLaunchAgent({ env, stdout, disable: true, onMutation })),
    ).rejects.toThrow(
      `gateway port ${port} is still busy after LaunchAgent stop\nPort ${port} is held by pid 4242.`,
    );

    expect(onMutation).toHaveBeenCalledWith({ mode: "disable-bootout" });
    expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(port, {
      env,
      assertCurrent: expect.any(Function),
    });
    expect(inspectPortUsage).toHaveBeenCalledWith(port, { probeHosts: ["127.0.0.1"] });
    expect(launchctlCommandNames()).toContain("bootout");
    expect(text()).toContain("used bootout fallback");
    expect(text()).not.toContain("Stopped LaunchAgent");
  });

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
    mockPort(18789, "busy", [{ pid: 9999, address: "TCP 127.0.0.1:18789 (LISTEN)" }]);
    probePortUsage.mockResolvedValue("busy");
    const result = await withEnvAsync(EXTERNAL_PROCESS, () => restartLaunchAgent({ env, stdout }));
    expect(inspectPortUsage).not.toHaveBeenCalled();
    expect(cleanStaleGatewayProcessesSync).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "completed" });
  });

  it("keeps an already-unloaded service disabled when --disable is passed", async () => {
    state.serviceLoaded = false;
    state.serviceRunning = false;
    await stopLaunchAgent({ env: ENV, stdout: new PassThrough(), disable: true });
    expect(state.serviceLoaded).toBe(false);
    expect(state.printDisabledOutput).toContain('"ai.openclaw.gateway" => disabled');
  });

  it("audits persisted disable when bootout fails", async () => {
    const onMutation = vi.fn();
    state.bootoutError = "bootout failed";
    await expect(stopLaunchAgent(control({ disable: true, onMutation }))).rejects.toThrow(
      "launchctl bootout failed",
    );
    expect(onMutation).toHaveBeenCalledWith({ mode: "disable" });
    expect(onMutation).not.toHaveBeenCalledWith({ mode: "disable-bootout" });
  });

  it("sanitizes launchctl details before writing warnings (--disable)", async () => {
    const { stdout, text } = captureOutput();
    state.disableError = "boom\n\u001b[31mred\u001b[0m\tmsg";

    await stopLaunchAgent({ env: ENV, stdout, disable: true });

    expect(text()).not.toContain("\u001b[31m");
    expect(text()).not.toContain("\nred\n");
    expect(text()).toContain("boom red msg");
    expect(state.serviceLoaded).toBe(false);
    expect(text()).toContain("Stopped LaunchAgent (degraded)");
  });

  it("starts a loaded LaunchAgent and audits before output", async () => {
    const write = vi.fn();
    const onMutation = vi.fn(({ mode }: { mode: string }) => {
      if (mode === "kickstart") {
        throw new Error("audit failed");
      }
    });

    await expect(
      startLaunchAgent({
        env: ENV,
        stdout: { write } as unknown as NodeJS.WritableStream,
        onMutation,
      }),
    ).resolves.toBeUndefined();

    expectServiceCalls("enable", "kickstart");
    expect(onMutation.mock.calls).toEqual([[{ mode: "enable" }], [{ mode: "kickstart" }]]);
    expect(
      expectDefined(onMutation.mock.invocationCallOrder[1], "kickstart audit call order"),
    ).toBeLessThan(expectDefined(write.mock.invocationCallOrder[0], "start output call order"));
  });

  it.each(["start", "restart"] as const)(
    "fails already-loaded %s bootstrap immediately instead of waiting for teardown",
    async (action) => {
      const env = action === "restart" ? createLaunchdEnvWithGatewayPort("18789") : ENV;
      const onMutation = vi.fn();
      if (action === "restart") {
        setLaunchAgentPlist(env, "ai.openclaw.gateway", ["node", "gateway.js"]);
        state.bootstrapLoadsServiceOnFailure = true;
      } else {
        state.kickstartError = "Could not find service";
        state.kickstartFailuresRemaining = 1;
      }
      state.bootstrapError = BOOTSTRAP_EXISTS;
      state.bootstrapCode = 5;
      // Real timers expose an accidental teardown retry; this job is still registered.
      const activate = action === "start" ? startLaunchAgent : restartLaunchAgent;
      const result = activate(launchAgentControlFixture(env, { onMutation }));
      await expect(result).rejects.toThrow(
        "launchctl bootstrap failed: Could not bootstrap service: 5: Input/output error",
      );
      expect(state.launchctlCalls.filter(([command]) => command === "bootstrap")).toHaveLength(1);
      if (action === "start") {
        expect(onMutation).not.toHaveBeenCalledWith({ mode: "bootstrap" });
      } else {
        await expect(result).rejects.toBeInstanceOf(Error);
        await expect(result).rejects.not.toThrow("is not loaded");
      }
    },
  );

  it("audits kickstart before a later output failure", async () => {
    const env = createLaunchdEnvWithGatewayPort("18789");
    const onMutation = vi.fn();
    const stdout = {
      write: vi.fn(() => {
        throw new Error("output failed");
      }),
    } as unknown as NodeJS.WritableStream;

    await expect(restartLaunchAgent({ env, stdout, onMutation })).rejects.toThrow("output failed");

    expect(onMutation.mock.calls).toEqual([[{ mode: "enable" }], [{ mode: "kickstart" }]]);
  });

  it.each([
    { scenario: "teardown", termination: "exit" },
    { scenario: "teardown", termination: "timeout" },
    { scenario: "in-progress", termination: "exit" },
    { scenario: "in-progress", termination: "timeout" },
  ] as const)(
    "accepts $scenario bootstrap output only after a completed command ($termination)",
    async ({ scenario, termination }) => {
      const env = createLaunchdEnvWithGatewayPort("18789");
      const detail =
        scenario === "teardown" ? "Bootstrap failed: 5: Input/output error" : BOOTSTRAP_PROGRESS;
      state.bootstrapError = detail;
      if (scenario === "teardown") {
        setLaunchAgentPlist(env, "ai.openclaw.gateway", ["node", "gateway.js"]);
        state.bootstrapTransient = true;
      } else {
        setLegacyGatewayLaunchAgentPlist(resolveLaunchAgentPlistPath(env), [
          "    <key>StandardOutPath</key>",
          "    <string>/Users/test/.openclaw-default/logs/gateway.log</string>",
        ]);
        state.bootstrapLoadsServiceOnFailure = true;
      }
      state.bootstrapCode = termination === "exit" ? 5 : 1;
      state.bootstrapTermination = termination;
      const onMutation = vi.fn();

      const restart = () => restartLaunchAgent(launchAgentControlFixture(env, { onMutation }));
      const result = scenario === "teardown" ? runWithFakeTimers(restart) : restart();

      if (termination === "exit") {
        await expect(result).resolves.toEqual({ outcome: "completed" });
      } else {
        await expect(result).rejects.toThrow(`launchctl bootstrap failed: ${detail}`);
      }
      // Recovery can restore the job after interruption, but must not turn the
      // failed restart into success by treating partial EIO output as a retry.
      expect(state.serviceLoaded).toBe(true);
      if (scenario === "teardown" || termination === "exit") {
        expect(onMutation).toHaveBeenCalledWith({ mode: "bootstrap" });
      } else {
        expect(onMutation).not.toHaveBeenCalledWith({ mode: "bootstrap" });
      }
      if (scenario === "in-progress") {
        expectCommands("print print enable bootout enable bootstrap print");
      }
    },
  );

  it("reports the LaunchAgent as unloaded when bootstrap teardown never clears", async () => {
    const env = createLaunchdEnvWithGatewayPort("18789");
    setLaunchAgentPlist(env, "ai.openclaw.gateway", ["node", "gateway.js"]);
    // EIO that never clears must stay bounded instead of retrying forever, and
    // the restore attempt fails with it, so the label really does stay absent.
    state.bootstrapError = "Bootstrap failed: 5: Input/output error";
    state.bootstrapCode = 5;

    const error = await runWithFakeTimers(() =>
      restartLaunchAgent(launchAgentControlFixture(env)),
    ).catch((caught: unknown) => caught);

    // bootout already removed the job, so the operator has to learn both why the
    // bootstrap failed and that nothing is left for KeepAlive to respawn.
    expect(state.serviceLoaded).toBe(false);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(
      "launchctl bootstrap failed: Bootstrap failed: 5: Input/output error",
    );
    expect(message).toContain(`LaunchAgent ${DOMAIN}/ai.openclaw.gateway is not loaded`);
    expect(message).toContain("The gateway is down and launchd has no job left to respawn it.");
    expect(message).toContain("openclaw gateway start");
  });

  it("protects the current launchd PID across dual-stack listeners", async () => {
    const managedPidAfterCleanup = 4343;
    const listeners = [
      { pid: 4343, address: "TCP 127.0.0.1:19002 (LISTEN)" },
      { pid: 4343, address: "TCP [::1]:19002 (LISTEN)" },
    ];
    vi.stubEnv("BOUNDARY_PARENT_ONLY", "synthetic");
    const env = createLaunchdEnvWithGatewayPort("19002");
    state.printOutput = ["state = running", `pid = ${managedPidAfterCleanup}`].join("\n");
    mockPort(19002, "busy", listeners);

    const result = await restartLaunchAgent(launchAgentControlFixture(env));

    expect(result).toEqual({ outcome: "completed" });
    expectProtectedCleanup(19002);
    expect(state.cleanupProtectedPids).toEqual([managedPidAfterCleanup]);
    expect(launchctlSpawnSync).toHaveBeenCalledWith(
      "launchctl",
      ["print", SERVICE_ID],
      expect.objectContaining({
        env: expect.not.objectContaining({ BOUNDARY_PARENT_ONLY: "synthetic" }),
        timeout: 2_000,
      }),
    );
    expect(inspectPortUsage).toHaveBeenCalledWith(19002, { probeHosts: ["127.0.0.1"] });
    expectServiceCalls("print", "print", "print", "enable", ["kickstart", "-k"]);
  });

  it("rejects mixed gateway port ownership before mutating launchd", async () => {
    const env = createLaunchdEnvWithGatewayPort("19002");
    setLaunchAgentPlist(env, "ai.openclaw.gateway", ["node", "gateway.js"]);
    const plistPath = resolveLaunchAgentPlistPath(env);
    const originalPlist = state.files.get(plistPath);
    inspectPortUsage.mockResolvedValue({
      port: 19002,
      status: "busy",
      listeners: [
        { pid: 4242, address: "TCP 127.0.0.1:19002 (LISTEN)" },
        { pid: 5151, address: "TCP [::1]:19002 (LISTEN)" },
      ],
      hints: ["Another process is listening on this port."],
    });
    formatPortDiagnostics.mockReturnValue(["Port 19002 is already in use."]);

    await expect(restartLaunchAgent(launchAgentControlFixture(env))).rejects.toThrow(
      "gateway port 19002 is busy but is not verifiably owned by LaunchAgent ai.openclaw.gateway",
    );

    expectProtectedCleanup(19002);
    expect(state.cleanupProtectedPids).toEqual([4242]);
    expect(inspectPortUsage).toHaveBeenCalledWith(19002, { probeHosts: ["127.0.0.1"] });
    expectServiceCalls("print", "print", "print");
    expect(state.files.get(plistPath)).toBe(originalPlist);
    expect(state.fileWrites).toHaveLength(0);
  });

  it.each([
    ["start", "stopped", "", true],
    ["start", "bootstrap-kickstart", "Could not find service", true],
    ["restart", "loaded", "", true],
    ["restart", "stopped", "", true],
    ["restart", "stopped", "Input/output error", false],
  ] as const)(
    "settles %s after kickstart failure (%s, %s, preserve=%s)",
    async (action, phase, detail, preserveDefinition) => {
      if (phase !== "loaded") {
        await stopLaunchAgent(control());
        expect(state.serviceLoaded).toBe(false);
      }
      state.kickstartError = detail;
      state.kickstartFailuresRemaining = phase === "bootstrap-kickstart" ? 2 : 1;
      state.kickstartUnloadsService = phase === "bootstrap-kickstart";
      const activate = action === "start" ? startLaunchAgent : restartLaunchAgent;
      const result = activate({ env: ENV, stdout: new PassThrough(), preserveDefinition });
      if (phase === "stopped") {
        await expect(result).resolves.toEqual(
          action === "start" ? undefined : { outcome: "completed" },
        );
        expect(state.serviceRunning).toBe(true);
      } else {
        await expect(result).rejects.toThrow(
          /launchctl kickstart failed:[\s\S]*LaunchAgent .* is loaded; launchd can retry/,
        );
        await expect(result).rejects.toThrow(`launchctl kickstart failed: ${detail}`.trim());
      }
      expect(state.serviceLoaded).toBe(true);
      expect(launchctlCommandNames().includes("bootstrap")).toBe(phase !== "loaded");
    },
  );

  it("restarts an unloaded LaunchAgent synchronously for a detached update helper that inherits only the configured label", async () => {
    state.serviceLoaded = false;
    state.kickstartError = "Could not find service";
    state.kickstartFailuresRemaining = 1;

    const result = await withEnvAsync(
      { ...EXTERNAL_PROCESS, OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" },
      async () => restartLaunchAgent(control({ preserveDefinition: true })),
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff).not.toHaveBeenCalled();
    expectCommands("print enable kickstart enable bootstrap kickstart");
    expect(state.kickstartFailuresRemaining).toBe(0);
    expect(state.serviceLoaded).toBe(true);
    expect(getSelfAndAncestorPidsSync).not.toHaveBeenCalled();
  });

  it("shows actionable guidance when launchctl gui domain does not support bootstrap", async () => {
    state.bootstrapError = GUI_UNAVAILABLE;
    let message = "";
    try {
      await install();
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("logged-in macOS GUI session");
    expect(message).toContain("wrong user (including sudo)");
    expect(message).toContain("https://docs.openclaw.ai/gateway");
  });
});

it("rejects invalid launchd labels that contain path separators", () => {
  expect(() =>
    resolveLaunchAgentPlistPath({ HOME: "/Users/test", OPENCLAW_LAUNCHD_LABEL: "../evil/label" }),
  ).toThrow("Invalid launchd label");
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
