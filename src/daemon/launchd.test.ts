await vi.hoisted(() => import("./launchd-ancestry.test-support.js"));
import "./launchd-fs.mocks.test-support.js";
// Launchd tests cover macOS service plist generation and command handling.
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
  launchAgentFixture,
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

function expectLaunchctlEnableBootstrapOrder(
  env: Record<string, string | undefined>,
  label = "ai.openclaw.gateway",
) {
  const plistPath = resolveLaunchAgentPlistPath(env);
  const serviceId = `${DOMAIN}/${label}`;
  const enableIndex = state.launchctlCalls.findIndex(
    (c) => c[0] === "enable" && c[1] === serviceId,
  );
  const bootstrapIndex = state.launchctlCalls.findIndex(
    (c) => c[0] === "bootstrap" && c[1] === DOMAIN && c[2] === plistPath,
  );

  expect(enableIndex).toBeGreaterThanOrEqual(0);
  expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
  expect(enableIndex).toBeLessThan(bootstrapIndex);

  return { domain: DOMAIN, label, serviceId, bootstrapIndex };
}

function launchctlCommandNames(): string[] {
  return state.launchctlCalls.map(([command]) => command ?? "");
}

function createSystemOwnershipError(
  status: "loaded" | "installed" | "unverifiable" = "loaded",
): Error {
  const ownership =
    status === "installed"
      ? {
          status,
          serviceTarget: "system/ai.openclaw.gateway",
          plistPath: "/Library/LaunchDaemons/custom-openclaw.plist",
        }
      : status === "unverifiable"
        ? {
            status,
            serviceTarget: "system/ai.openclaw.gateway",
            operation: "launchctl",
            detail: "permission denied",
          }
        : { status, serviceTarget: "system/ai.openclaw.gateway" };
  return Object.assign(new Error(`system ownership blocked: ${status}`), {
    code: "SYSTEM_LAUNCH_DAEMON_OWNERSHIP",
    ownership,
  });
}

describe("launchd runtime parsing", () => {
  it.each([
    ['disabled services = {\n\t"ai.openclaw.gateway" => false\n}', true],
    ['disabled services = {\n\t"ai.openclaw.gateway" => true\n}', false],
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

  it("fails closed when the LaunchAgent enabled state cannot be read", async () => {
    state.printDisabledError = "Operation not permitted";
    state.printDisabledCode = 1;

    await expect(isLaunchAgentEnabled({ env: createDefaultLaunchdEnv() })).rejects.toThrow(
      "launchctl print-disabled failed: Operation not permitted",
    );
  });
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

  it.each([
    {
      name: "installed but unloaded",
      installed: true,
      loaded: true,
      error:
        'Bad request.\nCould not find service "ai.openclaw.gateway" in domain for user gui: 501',
      expected: { status: "stopped" },
    },
    {
      name: "missing GUI session",
      installed: true,
      loaded: true,
      error: "Bootstrap failed: 125: Domain does not support specified action",
      expected: {
        status: "unknown",
        missingGuiSession: true,
        detail: "Bootstrap failed: 125: Domain does not support specified action",
        inspectionReason: "launchd-gui-domain-unavailable",
      },
    },
    {
      name: "unexpected inspection failure",
      installed: true,
      loaded: true,
      error: "Operation not permitted\nwhile reading launchd state",
      expected: {
        status: "unknown",
        detail: "Operation not permitted while reading launchd state",
        inspectionReason: "launchd-gui-domain-unavailable",
      },
    },
    {
      name: "missing job and plist",
      installed: false,
      loaded: false,
      error: "",
      expected: { status: "unknown", missingUnit: true },
    },
    {
      name: "system ownership even with a loaded user job",
      installed: false,
      loaded: true,
      error: "",
      expected: {
        status: "unknown",
        detail: "System LaunchDaemon system/ai.openclaw.gateway already owns this gateway label.",
        inspectionReason: "launchd-system-owned",
        systemLaunchDaemon: { status: "loaded", serviceTarget: "system/ai.openclaw.gateway" },
      },
    },
  ])("reports $name", async ({ installed, loaded, error, expected }) => {
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
      {
        label: "ai.openclaw.manual-update.1717168800",
        lastExitStatus: 0,
      },
      {
        label: "ai.openclaw.update.2026.5.12",
        lastExitStatus: 127,
      },
      {
        label: "ai.openclaw.update.2026.5.13-beta.1",
        pid: 8142,
        lastExitStatus: 0,
      },
    ]);
  });

  const updater = "ai.openclaw.update.2026.5.12";
  const profileUpdater = "ai.openclaw.tayoun.update.20260625T201026-0400";
  const gateway = "ai.openclaw.dev.team.update.20260625T201026-0400";
  const envFile = `/Users/test/.openclaw-tayoun/service-env/${profileUpdater}.env`;
  const wrapper = `/Users/test/.openclaw-tayoun/service-env/${profileUpdater}-env-wrapper.sh`;
  it.runIf(process.platform === "darwin").each<{
    name: string;
    env: NodeJS.ProcessEnv;
    list: string[];
    plists: Record<string, string[]>;
    generatedMarker?: boolean;
    expected: Array<{ label: string; pid?: number; lastExitStatus: number }>;
  }>([
    {
      name: "profile-scoped commands require an OpenClaw update command",
      env: ENV,
      list: [
        `4321 0 ${profileUpdater}`,
        `9876 0 ${gateway}`,
        "2468 0 ai.openclaw.fake.update.20260625T201026-0400",
        "1357 0 ai.openclaw.helper.update.20260625T201026-0400",
      ],
      plists: {
        [profileUpdater]: ["/opt/homebrew/bin/openclaw", "update", "--yes", "--json"],
        [gateway]: ["/opt/homebrew/bin/openclaw", "gateway", "run"],
        "ai.openclaw.fake.update.20260625T201026-0400": ["/bin/echo", "update", "--yes"],
        "ai.openclaw.helper.update.20260625T201026-0400": [
          "/usr/local/bin/openclaw-helper",
          "update",
          "--yes",
        ],
      },
      expected: [{ label: profileUpdater, pid: 4321, lastExitStatus: 0 }],
    },
    {
      name: "generated environment marker confirms an updater",
      env: ENV,
      list: [`4321 0 ${profileUpdater}`],
      plists: {
        [profileUpdater]: [
          LAUNCH_AGENT_ENV_WRAPPER_SHELL,
          wrapper,
          envFile,
          "/opt/homebrew/bin/openclaw",
          "gateway",
          "run",
        ],
      },
      generatedMarker: true,
      expected: [{ label: profileUpdater, pid: 4321, lastExitStatus: 0 }],
    },
    {
      name: "scanner marker cannot confirm a different job",
      env: { ...ENV, OPENCLAW_UPDATE_RUN_HANDOFF: "1" },
      list: [`9876 0 ${gateway}`],
      plists: { [gateway]: ["/opt/homebrew/bin/openclaw", "gateway", "run"] },
      expected: [],
    },
    {
      name: "current gateway labels cannot become stale update jobs",
      env: {
        OPENCLAW_PROFILE: "manual-update.profile",
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.manual-update.custom-label",
        OPENCLAW_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
        OPENCLAW_SERVICE_KIND: GATEWAY_SERVICE_KIND,
      },
      list: [
        "- 0 ai.openclaw.manual-update.1717168800",
        "812 0 ai.openclaw.manual-update.profile",
        "913 0 ai.openclaw.manual-update.custom-label",
      ],
      plists: {},
      expected: [{ label: "ai.openclaw.manual-update.1717168800", lastExitStatus: 0 }],
    },
  ])(
    "discovers only confirmed stale jobs: $name",
    async ({ env, list, plists, generatedMarker, expected }) => {
      state.listOutput = list.join("\n");
      for (const [label, args] of Object.entries(plists)) {
        setLaunchAgentPlist(env, label, args);
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
      [
        "configured updater",
        { XPC_SERVICE_NAME: "0", OPENCLAW_LAUNCHD_LABEL: updater },
        undefined,
        true,
      ],
      [
        "gateway profile",
        { LAUNCH_JOB_LABEL: updater, OPENCLAW_PROFILE: "update.2026.5.12" },
        undefined,
        false,
      ],
      [
        "gateway marker",
        {
          LAUNCH_JOB_LABEL: updater,
          OPENCLAW_LAUNCHD_LABEL: updater,
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
        },
        undefined,
        false,
      ],
      [
        "profile Node command",
        { ...ENV, LAUNCH_JOB_LABEL: profileUpdater },
        ["/usr/local/bin/node", "/opt/openclaw/openclaw.mjs", "update", "--yes"],
        true,
      ],
      [
        "native handoff marker",
        { ...ENV, LAUNCH_JOB_LABEL: profileUpdater, OPENCLAW_UPDATE_RUN_HANDOFF: "1" },
        undefined,
        true,
      ],
      [
        "unconfirmed configured handoff",
        { ...ENV, OPENCLAW_LAUNCHD_LABEL: gateway, OPENCLAW_UPDATE_RUN_HANDOFF: "1" },
        ["/opt/homebrew/bin/openclaw", "gateway", "run"],
        false,
      ],
      [
        "confirmed configured handoff",
        { ...ENV, OPENCLAW_LAUNCHD_LABEL: profileUpdater, OPENCLAW_UPDATE_RUN_HANDOFF: "1" },
        ["/opt/homebrew/bin/openclaw", "update", "--yes"],
        true,
      ],
      [
        "unconfirmed profile gateway",
        { ...ENV, LAUNCH_JOB_LABEL: profileUpdater },
        ["/opt/homebrew/bin/openclaw", "gateway", "run"],
        false,
      ],
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
    const plistPath = resolveLaunchAgentPlistPath(ENV);
    const warn = vi.fn();
    const secret = "legacy-secret";
    state.files.set(WRAPPER, "custom wrapper");
    state.files.set(
      plistPath,
      createTestLaunchAgentPlist({
        label: "ai.openclaw.gateway",
        programArguments: defaultProgramArguments,
        environment: { OPENAI_API_KEY: secret },
      }),
    );
    state.fileModes.set(plistPath, 0o600);

    await expect(repairLaunchAgentBootstrap({ env: ENV, warn })).resolves.toEqual({
      ok: true,
      status: "repaired",
    });
    expectLaunchctlEnableBootstrapOrder(ENV);
    expect(launchctlCommandNames()).not.toContain("kickstart");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("custom behavior"));
    expect(state.files.get(plistPath)).not.toContain(secret);
    expect(state.fileModes.get(plistPath)).toBe(0o644);
    expect(state.files.get("/Users/test/.openclaw/service-env/ai.openclaw.gateway.env")).toContain(
      secret,
    );
  });

  it.each<
    [
      name: string,
      detail: string,
      code: number,
      termination: typeof state.bootstrapTermination,
      running: boolean,
      kickstartError: string,
      expected: Awaited<ReturnType<typeof repairLaunchAgentBootstrap>>,
    ]
  >([
    [
      "already running",
      "Service already loaded",
      130,
      "exit",
      true,
      "",
      { ok: true, status: "already-loaded" },
    ],
    ...(["exit", "timeout", "signal"] as const).map(
      (
        termination,
      ): [
        string,
        string,
        number,
        typeof state.bootstrapTermination,
        boolean,
        string,
        Awaited<ReturnType<typeof repairLaunchAgentBootstrap>>,
      ] => {
        const detail =
          "Could not bootstrap service: 5: Input/output error: already exists in domain for gui/501";
        return [
          termination,
          detail,
          1,
          termination,
          false,
          "",
          termination === "exit"
            ? { ok: true, status: "already-loaded" }
            : { ok: false, status: "bootstrap-failed", detail },
        ];
      },
    ),
    [
      "missing GUI domain",
      "Could not find domain for user gui: 999999",
      1,
      "exit",
      true,
      "",
      {
        ok: false,
        status: "gui-session-unavailable",
        detail: "Could not find domain for user gui: 999999",
        domain: DOMAIN,
      },
    ],
    [
      "failed kickstart",
      "Service already loaded",
      130,
      "exit",
      false,
      "launchctl kickstart failed: permission denied",
      {
        ok: false,
        status: "kickstart-failed",
        detail: "launchctl kickstart failed: permission denied",
      },
    ],
  ])(
    "classifies bootstrap repair: %s",
    async (_name, detail, code, termination, running, kickstartError, expected) => {
      state.bootstrapError = detail;
      state.bootstrapCode = code;
      state.bootstrapTermination = termination;
      state.serviceRunning = running;
      state.kickstartError = kickstartError;
      state.kickstartFailuresRemaining = kickstartError ? 1 : 0;
      await expect(repairLaunchAgentBootstrap({ env: ENV })).resolves.toEqual(expected);
      const { serviceId } = expectLaunchctlEnableBootstrapOrder(ENV);
      expect(state.launchctlCalls.filter((call) => call[0] === "kickstart")).toEqual(
        !running && termination === "exit" ? [["kickstart", serviceId]] : [],
      );
    },
  );
});

describe("launchd uninstall", () => {
  it("rejects a permission-denied launchctl inspection", async () => {
    state.printError = "launchctl print permission denied";
    state.printFailuresRemaining = 1;

    await expect(isLaunchAgentLoaded({ env: createDefaultLaunchdEnv() })).rejects.toMatchObject({
      reason: "launchd-gui-domain-unavailable",
    });
  });

  it.each([
    { operation: "rename", code: "EACCES" },
    { operation: "lstat", code: "EACCES" },
    { operation: "rename", code: "ENOENT" },
  ] as const)(
    "reports $operation $code without leaking the plist path",
    async ({ operation, code }) => {
      const plistPath = resolveLaunchAgentPlistPath(ENV);
      if (operation === "rename") {
        state.files.set(plistPath, "RunAtLoad=true");
      }
      vi.mocked(fs[operation]).mockRejectedValueOnce(
        Object.assign(new Error(`${code}: ${operation} '${plistPath}'`), { code }),
      );
      const uninstall = uninstallLaunchAgent(launchAgentControlFixture(ENV));
      await expect(uninstall).rejects.toThrow(`LaunchAgent removal failed (${code})`);
      await expect(uninstall).rejects.not.toThrow(plistPath);
      if (operation === "rename") {
        expect(state.files.has(plistPath)).toBe(true);
      }
    },
  );

  it("preserves the plist when launchctl cannot boot out the service", async () => {
    const plistPath = resolveLaunchAgentPlistPath(ENV);
    state.files.set(plistPath, "RunAtLoad=true");
    state.bootoutError = "launchctl bootout permission denied";

    await expect(uninstallLaunchAgent(launchAgentControlFixture(ENV))).rejects.toThrow(
      "launchctl bootout failed: launchctl bootout permission denied",
    );
    expect(state.files.has(plistPath)).toBe(true);
  });

  it.each(["missing", "stopped symlink", "concurrently removed"])(
    "keeps removal idempotent for a %s LaunchAgent",
    async (kind) => {
      const plistPath = resolveLaunchAgentPlistPath(ENV);
      if (kind !== "missing") {
        state.files.set(plistPath, "RunAtLoad=true");
      }
      if (kind === "stopped symlink") {
        state.serviceLoaded = false;
        state.bootoutError = "Boot-out failed: 5: Input/output error";
      }
      if (kind === "concurrently removed") {
        vi.mocked(fs.rename).mockImplementationOnce(async () => {
          state.files.delete(plistPath);
          throw Object.assign(new Error(`ENOENT: no such file, rename '${plistPath}'`), {
            code: "ENOENT",
          });
        });
      }
      await expect(uninstallLaunchAgent(launchAgentControlFixture(ENV))).resolves.toBeUndefined();
      expect(state.files.has(plistPath)).toBe(false);
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
      {
        XPC_SERVICE_NAME: "0",
        OPENCLAW_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
        OPENCLAW_SERVICE_KIND: GATEWAY_SERVICE_KIND,
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

  it("aborts before mutation when prior LaunchAgent supervision is ambiguous", async () => {
    const plistPath = resolveLaunchAgentPlistPath(ENV);
    const previous = setLaunchAgentPlist(ENV, "ai.openclaw.gateway", [
      "/previous/node",
      "/previous/openclaw.mjs",
      "gateway",
    ]);
    state.printError = "launchctl print permission denied";
    // A denied membership probe must refuse before any native mutation.
    state.printFailuresRemaining = 2;

    await expect(
      installLaunchAgent({
        env: ENV,
        stdout: new PassThrough(),
        programArguments: defaultProgramArguments,
      }),
    ).rejects.toMatchObject({ reason: "service-membership-unverified" });

    expect(state.files.get(plistPath)).toBe(previous);
    expect(state.fileWrites).toEqual([]);
    expect(launchctlCommandNames()).toEqual(["print"]);
  });

  it("aborts before mutation when launchd has the only copy of the prior definition", async () => {
    state.serviceStates.set(`${DOMAIN}/ai.openclaw.gateway`, "running");

    await expect(installLaunchAgent(defaultLaunchAgentFixture(ENV))).rejects.toThrow(
      "is loaded but its plist is missing",
    );

    expect(state.serviceLoaded).toBe(true);
    expect(state.serviceRunning).toBe(true);
    expect(state.fileWrites).toEqual([]);
    expect(launchctlCommandNames()).toEqual(["print", "print"]);
  });

  it.each(["fresh", "unloaded reinstall"] as const)(
    "restores the previous %s state after failed install",
    async (kind) => {
      const plistPath = resolveLaunchAgentPlistPath(ENV);
      const previous =
        kind === "unloaded reinstall"
          ? setLaunchAgentPlist(ENV, "ai.openclaw.gateway", [
              "/previous/node",
              "/previous/openclaw.mjs",
              "gateway",
            ])
          : undefined;
      state.serviceLoaded = false;
      state.serviceRunning = false;
      state.bootstrapError = "Operation not permitted";
      state.bootstrapTransient = true;
      if (kind === "fresh") {
        state.bootoutError = "Boot-out failed: 5: Input/output error";
        state.bootoutCode = 5;
      }
      const operation = installLaunchAgent(
        defaultLaunchAgentFixture(
          ENV,
          kind === "fresh" ? { environment: { OPENCLAW_GATEWAY_PORT: "19000" } } : {},
        ),
      );
      await expect(operation).rejects.toThrow(
        "launchctl bootstrap failed: Operation not permitted",
      );
      if (kind === "fresh") {
        await expect(operation).rejects.toBeInstanceOf(Error);
        await expect(operation).rejects.toMatchObject({
          message: "launchctl bootstrap failed: Operation not permitted",
        });
        expect(state.files.has(plistPath)).toBe(false);
        expect(state.files.has(ENV_FILE)).toBe(false);
        expect(state.files.has(WRAPPER)).toBe(false);
      } else {
        expect(state.files.get(plistPath)).toBe(previous);
        expect(state.serviceLoaded).toBe(false);
        expect(state.serviceRunning).toBe(false);
      }
      expect(launchctlCommandNames()).toEqual(["print", "print", "enable", "bootstrap", "print"]);
    },
  );

  it("fails closed when rollback cannot determine the replacement state", async () => {
    const plistPath = resolveLaunchAgentPlistPath(ENV);
    // Membership and the prior snapshot see absence; rollback sees the error.
    state.printNotLoadedRemaining = 2;
    state.printError = "launchctl print permission denied";
    state.printFailuresRemaining = 1;
    state.bootstrapError = "Operation not permitted";

    const error = await installLaunchAgent(defaultLaunchAgentFixture(ENV)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("launchctl bootstrap failed: Operation not permitted"),
      }),
      expect.objectContaining({ message: expect.stringContaining("could not determine whether") }),
    ]);
    expect(state.files.has(plistPath)).toBe(true);
    expect(launchctlCommandNames()).toEqual(["print", "print", "enable", "bootstrap", "print"]);
  });

  it("restores prior supervision and private artifacts without changing enabled policy", async () => {
    const plistPath = resolveLaunchAgentPlistPath(ENV);
    const previousEnv = "export OPENCLAW_GATEWAY_PORT='18789'\n";
    const previousWrapper = '#!/bin/sh\n. "$1"\nshift\nexec "$@"\n';
    const previous = createTestLaunchAgentPlist({
      label: "ai.openclaw.gateway",
      programArguments: [
        "/bin/sh",
        WRAPPER,
        ENV_FILE,
        "/previous/node",
        "/previous/openclaw.mjs",
        "gateway",
      ],
    });
    state.files.set(plistPath, previous);
    state.fileModes.set(plistPath, 0o600);
    state.files.set(ENV_FILE, previousEnv);
    state.files.set(WRAPPER, previousWrapper);
    state.fileModes.set(ENV_FILE, 0o600);
    state.fileModes.set(WRAPPER, 0o700);
    state.serviceLoaded = true;
    state.serviceRunning = true;
    state.bootstrapError = "Operation not permitted";
    state.bootstrapTransient = true;

    await expect(
      installLaunchAgent({
        env: ENV,
        stdout: new PassThrough(),
        programArguments: defaultProgramArguments,
        preserveAutoStart: true,
        environment: { OPENCLAW_GATEWAY_PORT: "19000" },
      }),
    ).rejects.toThrow("launchctl bootstrap failed: Operation not permitted");

    expect(state.files.get(plistPath)).toBe(previous);
    expect(state.fileModes.get(plistPath)).toBe(0o600);
    expect(state.files.get(ENV_FILE)).toBe(previousEnv);
    expect(state.files.get(WRAPPER)).toBe(previousWrapper);
    expect(state.fileModes.get(ENV_FILE)).toBe(0o600);
    expect(state.fileModes.get(WRAPPER)).toBe(0o700);
    expect(state.serviceLoaded).toBe(true);
    expect(state.serviceRunning).toBe(true);
    expect(launchctlCommandNames()).toEqual([
      "print",
      "print-disabled",
      "print",
      "bootout",
      "unload",
      "bootstrap",
      "print",
      "bootstrap",
    ]);
  });

  it.each([false, true])(
    "preserves disabled policy and supervision after bootstrap failure=%s",
    async (fail) => {
      const plistPath = resolveLaunchAgentPlistPath(ENV);
      const previous = setLaunchAgentPlist(ENV, "ai.openclaw.gateway", [
        "/previous/node",
        "/previous/openclaw.mjs",
        "gateway",
      ]);
      state.fileModes.set(plistPath, 0o600);
      state.serviceLoaded = true;
      state.serviceRunning = true;
      state.printDisabledOutput = 'disabled services = {\n\t"ai.openclaw.gateway" => disabled\n}';
      if (fail) {
        state.bootstrapError = "injected activation failure";
        state.bootstrapTransient = true;
      }
      const operation = installLaunchAgent({
        env: ENV,
        stdout: new PassThrough(),
        programArguments: defaultProgramArguments,
        preserveAutoStart: true,
      });
      if (fail) {
        await expect(operation).rejects.toThrow("injected activation failure");
        expect(state.files.get(plistPath)).toBe(previous);
      } else {
        await operation;
      }
      expect(state.serviceLoaded).toBe(true);
      expect(state.serviceRunning).toBe(true);
      expect(await isLaunchAgentEnabled({ env: ENV })).toBe(false);
      expect(
        launchctlCommandNames().filter((command) =>
          ["enable", "bootstrap", "disable"].includes(command),
        ),
      ).toEqual(
        fail
          ? ["enable", "bootstrap", "disable", "enable", "bootstrap", "disable"]
          : ["enable", "bootstrap", "disable"],
      );
    },
  );
  it.each(["install", "stage", "start", "restart"] as const)(
    "refuses %s before user LaunchAgent mutation when a system daemon owns it",
    async (action) => {
      launchdSystemState.assertNoSystemLaunchDaemonOwnership.mockRejectedValue(
        createSystemOwnershipError(),
      );
      const args = defaultLaunchAgentFixture(ENV);
      const operations = {
        install: installLaunchAgent,
        stage: stageLaunchAgent,
        start: startLaunchAgent,
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

    await expect(installLaunchAgent(defaultLaunchAgentFixture(ENV))).rejects.toThrow(
      "system ownership blocked: installed",
    );

    expect(state.files.has(resolveLaunchAgentPlistPath(ENV))).toBe(false);
    expect(launchctlCommandNames()).toEqual(["print", "print"]);
  });

  it("restores the previous plist when staged publication loses ownership", async () => {
    const plistPath = resolveLaunchAgentPlistPath(ENV);
    const previous =
      "<plist><dict><key>Label</key><string>previous</string><key>EnvironmentVariables</key><dict><key>SYNTHETIC_INLINE</key><string>private fixture value</string></dict></dict></plist>";
    state.files.set(plistPath, previous);
    state.fileModes.set(plistPath, 0o600);
    launchdSystemState.assertNoSystemLaunchDaemonOwnership
      .mockResolvedValueOnce()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(createSystemOwnershipError("loaded"));

    await expect(
      stageLaunchAgent({
        env: ENV,
        stdout: new PassThrough(),
        programArguments: defaultProgramArguments,
      }),
    ).rejects.toThrow("system ownership blocked: loaded");

    expect(state.files.get(plistPath)).toBe(previous);
    expect(state.fileModes.get(plistPath)).toBe(0o600);
    expect(state.launchctlCalls).toEqual([]);
  });

  it("keeps loaded reinstall deactivation failures fatal", async () => {
    const plistPath = resolveLaunchAgentPlistPath(ENV);
    state.files.set(
      plistPath,
      createTestLaunchAgentPlist({
        label: "ai.openclaw.gateway",
        programArguments: defaultProgramArguments,
      }),
    );
    state.bootoutError = "Boot-out failed: 5: Input/output error";
    state.bootoutCode = 5;

    await expect(installLaunchAgent(defaultLaunchAgentFixture(ENV))).rejects.toThrow(
      "launchctl bootout failed during LaunchAgent install: Boot-out failed: 5: Input/output error",
    );

    expect(launchctlCommandNames()).toEqual(["print", "print", "bootout", "print", "bootout"]);
  });

  it("writes LaunchAgent environment to an owner-only env file when provided", async () => {
    const tmpDir = "/Users/test/.openclaw/tmp";
    const apiKey = "secret-api-key";
    await installLaunchAgent(
      defaultLaunchAgentFixture(ENV, {
        environment: { TMPDIR: tmpDir, OPENAI_API_KEY: apiKey, NODE_OPTIONS: "", UNUSED: "" },
      }),
    );

    const plistPath = resolveLaunchAgentPlistPath(ENV);
    const plist = state.files.get(plistPath) ?? "";
    const logPath = "/Users/test/Library/Logs/openclaw/gateway.log";
    // readLastGatewayErrorLine only reads stdout on darwin, so a stderr target
    // that is not the stdout log discards every pre-logger startup failure.
    expect(plist).toContain(`<key>StandardOutPath</key>\n    <string>${logPath}</string>`);
    expect(plist).toContain(`<key>StandardErrorPath</key>\n    <string>${logPath}</string>`);
    expect(plist).not.toContain("<key>StandardErrorPath</key>\n    <string>/dev/null</string>");

    expect(plist).not.toContain("<key>EnvironmentVariables</key>");
    expect(plist).not.toContain(apiKey);
    expect(readPlistProgramArgumentStrings(plist)).toEqual([
      LAUNCH_AGENT_ENV_WRAPPER_SHELL,
      WRAPPER,
      ENV_FILE,
      ...defaultProgramArguments,
    ]);
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
    expect(command?.programArguments).toEqual(defaultProgramArguments);
    expect(command?.environment?.TMPDIR).toBe(tmpDir);
    expect(command?.environment?.OPENAI_API_KEY).toBe(apiKey);
    expect(command?.environment?.NODE_OPTIONS).toBe("");
    expect(command?.environmentValueSources?.TMPDIR).toBe("file");
    expect(command?.environmentValueSources?.OPENAI_API_KEY).toBe("file");
  });

  it("retains custom Node CA trust when reinstalling a generated owner-only LaunchAgent", async () => {
    const extraCaCerts = "/Users/test/certs/corporate-ca.pem";
    await installLaunchAgent(
      defaultLaunchAgentFixture(ENV, {
        environment: { NODE_EXTRA_CA_CERTS: extraCaCerts },
      }),
    );

    const installedCommand = await readLaunchAgentProgramArguments(ENV);
    expect(installedCommand?.environment?.NODE_EXTRA_CA_CERTS).toBe(extraCaCerts);
    expect(installedCommand?.environmentValueSources?.NODE_EXTRA_CA_CERTS).toBe("file");
    const initialEnvWrites = state.fileWrites.filter(({ path }) => path === ENV_FILE).length;

    await installLaunchAgent(
      defaultLaunchAgentFixture(ENV, {
        environment: installedCommand?.environment,
      }),
    );

    const refreshedCommand = await readLaunchAgentProgramArguments(ENV);
    expect(refreshedCommand?.environment?.NODE_EXTRA_CA_CERTS).toBe(extraCaCerts);
    expect(refreshedCommand?.environmentValueSources?.NODE_EXTRA_CA_CERTS).toBe("file");
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
    await installLaunchAgent(
      defaultLaunchAgentFixture(ENV, {
        environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      }),
    );
    const generatedWrapper = state.files.get(WRAPPER);
    if (!generatedWrapper) {
      throw new Error("expected generated wrapper");
    }
    state.files.set(
      WRAPPER,
      generatedWrapper.replace('exec "$@"', 'echo "custom-secret-provider-marker"\nexec "$@"'),
    );
    state.launchctlCalls.length = 0;

    let output = "";
    const stdout = capturePassThroughOutput((text) => (output += text), "utf8");

    await restartLaunchAgent({
      env: ENV,
      stdout,
    });

    expect(output).toContain("Warning:");
    expect(output).toContain("contains custom behavior and will be overwritten");
    expect(output).toContain("openclaw gateway install --wrapper <path>");
    expect(output).toContain("OPENCLAW_WRAPPER");
    expect(state.files.get(WRAPPER)).toBe(generatedWrapper);
  });

  it("rewrites legacy LaunchAgent environment wrappers to a system shell executable", async () => {
    await installLaunchAgent(
      defaultLaunchAgentFixture(ENV, {
        environment: { OPENCLAW_GATEWAY_PORT: "19007" },
      }),
    );

    const plistPath = resolveLaunchAgentPlistPath(ENV);
    const legacyPlist = (state.files.get(plistPath) ?? "").replace(
      [
        `<string>${LAUNCH_AGENT_ENV_WRAPPER_SHELL}</string>`,
        `<string>${WRAPPER}</string>`,
        `<string>${ENV_FILE}</string>`,
      ].join("\n      "),
      [`<string>${WRAPPER}</string>`, `<string>${ENV_FILE}</string>`].join("\n      "),
    );
    expect(readPlistProgramArgumentStrings(legacyPlist)).toEqual([
      WRAPPER,
      ENV_FILE,
      ...defaultProgramArguments,
    ]);
    state.files.set(plistPath, legacyPlist);
    state.launchctlCalls.length = 0;

    await restartLaunchAgent(launchAgentControlFixture(ENV));

    const rewritten = state.files.get(plistPath) ?? "";
    expect(readPlistProgramArgumentStrings(rewritten)).toEqual([
      LAUNCH_AGENT_ENV_WRAPPER_SHELL,
      WRAPPER,
      ENV_FILE,
      ...defaultProgramArguments,
    ]);
    expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(
      19007,
      expect.objectContaining({
        resolveProtectedPid: expect.any(Function),
      }),
    );
  });

  it("repairs a mangled label-derived service-env wrapper path on restart", async () => {
    const callerEnv = createDefaultLaunchdEnv();
    const serviceEnv = {
      ...callerEnv,
      OPENCLAW_STATE_DIR: "/Users/test/service-env/custom-state",
    };
    await installLaunchAgent(
      defaultLaunchAgentFixture(serviceEnv, {
        environment: {
          OPENCLAW_GATEWAY_PORT: "18789",
          OPENCLAW_STATE_DIR: serviceEnv.OPENCLAW_STATE_DIR,
        },
      }),
    );

    const plistPath = resolveLaunchAgentPlistPath(callerEnv);
    const envFilePath = "/Users/test/service-env/custom-state/service-env/ai.openclaw.gateway.env";
    const wrapperPath =
      "/Users/test/service-env/custom-state/service-env/ai.openclaw.gateway-env-wrapper.sh";
    const callerEnvFilePath = "/Users/test/.openclaw/service-env/ai.openclaw.gateway.env";
    const callerWrapperPath =
      "/Users/test/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh";
    const mangledEnvFilePath =
      "/Users/test/service-env/custom-state/service-env/[ai.openclaw.gateway.env](http:/ai.openclaw.gateway.env)";
    const mangledWrapperPath =
      "/Users/test/service-env/custom-state/service-env/[ai.openclaw.gateway-env-wrapper.sh](http:/ai.openclaw.gateway-env-wrapper.sh)";
    state.files.set(
      plistPath,
      (state.files.get(plistPath) ?? "")
        .replace(wrapperPath, mangledWrapperPath)
        .replace(envFilePath, mangledEnvFilePath),
    );

    const command = await readLaunchAgentProgramArguments(callerEnv);
    expect(command?.programArguments).toEqual(defaultProgramArguments);
    expect(command?.environment?.OPENCLAW_GATEWAY_PORT).toBe("18789");
    expect(command?.environment?.OPENCLAW_STATE_DIR).toBe(serviceEnv.OPENCLAW_STATE_DIR);
    expect(command?.environmentValueSources?.OPENCLAW_GATEWAY_PORT).toBe("file");

    await restartLaunchAgent(launchAgentControlFixture(callerEnv));

    const rewritten = state.files.get(plistPath) ?? "";
    expect(readPlistProgramArgumentStrings(rewritten)).toEqual([
      LAUNCH_AGENT_ENV_WRAPPER_SHELL,
      callerWrapperPath,
      callerEnvFilePath,
      ...defaultProgramArguments,
    ]);
    expect(rewritten).not.toContain(mangledEnvFilePath);
    expect(rewritten).not.toContain(mangledWrapperPath);
    const rewrittenEnv = state.files.get(callerEnvFilePath) ?? "";
    expect(rewrittenEnv).toContain("export OPENCLAW_GATEWAY_PORT='18789'");
    expect(rewrittenEnv).toContain(
      "export OPENCLAW_STATE_DIR='/Users/test/service-env/custom-state'",
    );
  });

  it("publishes the rewritten plist before restart bootstrap", async () => {
    const plistPath = resolveLaunchAgentPlistPath(ENV);
    state.serviceLoaded = false;
    setLegacyGatewayLaunchAgentPlist(plistPath, [
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
    await restartLaunchAgent(launchAgentControlFixture(ENV));

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
    let output = "";
    const stdout = capturePassThroughOutput((text) => (output += text));
    state.bootoutLeavesLoaded = loaded;
    state.serviceRunning = running;
    isPidDefinitelyDead.mockReturnValue(dead);

    await expect(runWithFakeTimers(() => stopLaunchAgent({ env: ENV, stdout }))).rejects.toThrow(
      "launchctl bootout gui/",
    );
    expect(output).not.toContain("Stopped LaunchAgent");
    expect(cleanStaleGatewayProcessesSync).not.toHaveBeenCalled();
  });

  it("refuses verified stop when launchd reports running without a PID", async () => {
    state.printOutput = "state = running\n";
    await expect(stopLaunchAgent(launchAgentControlFixture(ENV))).rejects.toMatchObject({
      reason: "service-membership-unverified",
    });
  });

  it("waits for both asynchronous label teardown and process exit", async () => {
    vi.useFakeTimers();
    let output = "";
    state.bootoutLeavesLoaded = true;
    isPidDefinitelyDead.mockReturnValue(false);
    try {
      const stopped = stopLaunchAgent({
        env: createDefaultLaunchdEnv(),
        stdout: capturePassThroughOutput((text) => (output += text)),
      });
      await vi.advanceTimersByTimeAsync(500);
      expect(output).not.toContain("Stopped LaunchAgent");
      state.serviceLoaded = false;
      await vi.advanceTimersByTimeAsync(500);
      expect(output).not.toContain("Stopped LaunchAgent");
      isPidDefinitelyDead.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(500);
      await stopped;
      expect(output).toContain("Stopped LaunchAgent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not park an external LaunchAgent", async () => {
    await withEnvAsync(EXTERNAL_PROCESS, async () => {
      await expect(parkCurrentLaunchAgentForMaintenance({ env: ENV })).resolves.toBe(false);
    });

    expect(state.launchctlCalls).toEqual([["print", `${DOMAIN}/ai.openclaw.gateway`]]);
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
          XPC_SERVICE_NAME: "0",
          OPENCLAW_SERVICE_MARKER: "openclaw",
          OPENCLAW_SERVICE_KIND: "gateway",
          OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
        },
        async () => {
          if (action === "stop") {
            await expect(stopLaunchAgent(launchAgentControlFixture(ENV))).rejects.toThrow(
              "Refusing to stop LaunchAgent ai.openclaw.gateway from inside the same launchd service",
            );
          } else {
            await expect(restartLaunchAgent(launchAgentControlFixture(ENV))).resolves.toEqual({
              outcome: "scheduled",
            });
            expect(
              launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff,
            ).toHaveBeenCalledWith({ env: ENV, mode: "kickstart", waitForPid: process.pid });
          }
        },
      );
      expect(launchctlCommandNames()).toEqual(["print"]);
    },
  );

  it("allows external LaunchAgent label overrides to stop the selected target", async () => {
    const env = {
      ...createDefaultLaunchdEnv(),
      OPENCLAW_LAUNCHD_LABEL: "com.example.openclaw.gateway",
    };
    let output = "";
    const stdout = capturePassThroughOutput((text) => (output += text));

    await withEnvAsync(EXTERNAL_PROCESS, async () => {
      await stopLaunchAgent({ env, stdout });
    });

    const serviceId = `${DOMAIN}/com.example.openclaw.gateway`;
    expect(state.launchctlCalls).toContainEqual(["bootout", serviceId]);
    expect(launchctlCommandNames()).not.toContain("disable");
    expect(state.serviceLoaded).toBe(false);
    expect(output).toContain("Stopped LaunchAgent");
  });

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
      let output = "";
      const stdout = capturePassThroughOutput((text) => (output += text));
      await runWithFakeTimers(() => stopLaunchAgent({ env, stdout }));
      expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(19011, {
        env,
        assertCurrent: expect.any(Function),
      });
      expect(inspectPortUsage).toHaveBeenCalledWith(19011, {
        probeHosts: ["192.0.2.40"],
      });
      if (portStatus === "busy") {
        expect(probePortUsage).toHaveBeenCalledTimes(3);
        expect(probePortUsage).toHaveBeenCalledWith(19011, ["192.0.2.40"]);
      } else {
        expect(probePortUsage).not.toHaveBeenCalled();
      }
      expect(output).toContain("Stopped LaunchAgent");
    },
  );

  it("rejects stop success when disable fails and the gateway port stays busy", async () => {
    const port = 19008;
    const env = createLaunchdEnvWithGatewayPort(String(port));
    let output = "";
    const stdout = capturePassThroughOutput((text) => (output += text));
    const onMutation = vi.fn();
    state.disableError = "Operation not permitted";
    inspectPortUsage.mockResolvedValue({ port, status: "busy", listeners: [], hints: [] });
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
    expect(output).toContain("used bootout fallback");
    expect(output).not.toContain("Stopped LaunchAgent");
  });

  it.each(["stop", "restart"] as const)(
    "does not mistake a co-located Gateway port for the node-host port during %s",
    async (action) => {
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
      let output = "";
      const stdout = capturePassThroughOutput((text) => (output += text));
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners:
          action === "stop" ? [] : [{ pid: 9999, address: "TCP 127.0.0.1:18789 (LISTEN)" }],
        hints: [],
      });
      probePortUsage.mockResolvedValue("busy");
      const result = await withEnvAsync(EXTERNAL_PROCESS, async () =>
        action === "stop" ? stopLaunchAgent({ env, stdout }) : restartLaunchAgent({ env, stdout }),
      );
      expect(inspectPortUsage).not.toHaveBeenCalled();
      expect(cleanStaleGatewayProcessesSync).not.toHaveBeenCalled();
      if (action === "stop") {
        expect(output).toContain("Stopped LaunchAgent");
      } else {
        expect(result).toEqual({ outcome: "completed" });
      }
    },
  );

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
    await expect(
      stopLaunchAgent({
        env: createDefaultLaunchdEnv(),
        stdout: new PassThrough(),
        disable: true,
        onMutation,
      }),
    ).rejects.toThrow("launchctl bootout failed");
    expect(onMutation).toHaveBeenCalledWith({ mode: "disable" });
    expect(onMutation).not.toHaveBeenCalledWith({ mode: "disable-bootout" });
  });

  it("sanitizes launchctl details before writing warnings (--disable)", async () => {
    const stdout = capturePassThroughOutput((text) => (output += text));
    let output = "";
    state.disableError = "boom\n\u001b[31mred\u001b[0m\tmsg";

    await stopLaunchAgent({ env: ENV, stdout, disable: true });

    expect(output).not.toContain("\u001b[31m");
    expect(output).not.toContain("\nred\n");
    expect(output).toContain("boom red msg");
    expect(state.serviceLoaded).toBe(false);
    expect(output).toContain("Stopped LaunchAgent (degraded)");
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

    expect(state.launchctlCalls).toEqual([
      ["enable", SERVICE_ID],
      ["kickstart", SERVICE_ID],
    ]);
    expect(onMutation.mock.calls).toEqual([[{ mode: "enable" }], [{ mode: "kickstart" }]]);
    expect(
      expectDefined(onMutation.mock.invocationCallOrder[1], "kickstart audit call order"),
    ).toBeLessThan(expectDefined(write.mock.invocationCallOrder[0], "start output call order"));
  });

  it("bootstraps an unloaded LaunchAgent and audits the successful mutation", async () => {
    const onMutation = vi.fn();
    state.kickstartError = "Could not find service";
    state.kickstartFailuresRemaining = 1;

    await startLaunchAgent(
      launchAgentControlFixture(ENV, {
        onMutation,
      }),
    );

    expect(state.launchctlCalls).toEqual([
      ["enable", SERVICE_ID],
      ["kickstart", SERVICE_ID],
      ["bootstrap", DOMAIN, resolveLaunchAgentPlistPath(ENV)],
      ["kickstart", SERVICE_ID],
    ]);
    expect(onMutation.mock.calls).toEqual([
      [{ mode: "enable" }],
      [{ mode: "bootstrap" }],
      [{ mode: "kickstart" }],
    ]);
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
      state.bootstrapError =
        "Could not bootstrap service: 5: Input/output error: already exists in domain for gui/501";
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

  it.each(["exit", "timeout", "signal"] as const)(
    "retries teardown bootstrap output only after a completed command (%s)",
    async (termination) => {
      const env = createLaunchdEnvWithGatewayPort("18789");
      setLaunchAgentPlist(env, "ai.openclaw.gateway", ["node", "gateway.js"]);
      state.bootstrapError = "Bootstrap failed: 5: Input/output error";
      state.bootstrapCode = termination === "exit" ? 5 : 1;
      state.bootstrapTermination = termination;
      state.bootstrapTransient = true;
      const onMutation = vi.fn();

      const result = runWithFakeTimers(() =>
        restartLaunchAgent(launchAgentControlFixture(env, { onMutation })),
      );

      if (termination === "exit") {
        await expect(result).resolves.toEqual({ outcome: "completed" });
      } else {
        await expect(result).rejects.toThrow(
          "launchctl bootstrap failed: Bootstrap failed: 5: Input/output error",
        );
      }
      // Recovery can restore the job after interruption, but must not turn the
      // failed restart into success by treating partial EIO output as a retry.
      expect(state.serviceLoaded).toBe(true);
      expect(onMutation).toHaveBeenCalledWith({ mode: "bootstrap" });
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

  it.each(["exit", "timeout", "signal"] as const)(
    "accepts in-progress bootstrap output only after a completed command (%s)",
    async (termination) => {
      const env = createLaunchdEnvWithGatewayPort("18789");
      const plistPath = resolveLaunchAgentPlistPath(env);
      setLegacyGatewayLaunchAgentPlist(plistPath, [
        "    <key>StandardOutPath</key>",
        "    <string>/Users/test/.openclaw-default/logs/gateway.log</string>",
      ]);
      state.bootstrapError = "Bootstrap failed: 37: Operation already in progress";
      state.bootstrapCode = termination === "exit" ? 5 : 1;
      state.bootstrapTermination = termination;
      state.bootstrapLoadsServiceOnFailure = true;
      const onMutation = vi.fn();

      const result = restartLaunchAgent(launchAgentControlFixture(env, { onMutation }));
      if (termination === "exit") {
        await expect(result).resolves.toEqual({ outcome: "completed" });
        expect(onMutation).toHaveBeenCalledWith({ mode: "bootstrap" });
      } else {
        await expect(result).rejects.toThrow(
          "launchctl bootstrap failed: Bootstrap failed: 37: Operation already in progress",
        );
        expect(onMutation).not.toHaveBeenCalledWith({ mode: "bootstrap" });
      }

      expect(launchctlCommandNames()).toEqual([
        "print",
        "print",
        "enable",
        "bootout",
        "enable",
        "bootstrap",
        "print",
      ]);
      expect(launchctlCommandNames()).not.toContain("kickstart");
    },
  );

  it("uses the final repeated LaunchAgent port flag for restart stale cleanup", async () => {
    await installLaunchAgent(
      launchAgentFixture(ENV, [...defaultProgramArguments, "--port", "18789", "--port=19008"], {
        environment: {},
      }),
    );
    state.launchctlCalls.length = 0;

    await restartLaunchAgent(launchAgentControlFixture(ENV));

    expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(
      19008,
      expect.objectContaining({
        resolveProtectedPid: expect.any(Function),
      }),
    );
    expect(inspectPortUsage).toHaveBeenCalledWith(19008, {
      probeHosts: ["127.0.0.1"],
    });
  });

  it("ignores invalid stored LaunchAgent environment ports for stale cleanup", async () => {
    await installLaunchAgent(
      defaultLaunchAgentFixture(ENV, {
        environment: { OPENCLAW_GATEWAY_PORT: "65536" },
      }),
    );
    state.launchctlCalls.length = 0;

    await restartLaunchAgent(launchAgentControlFixture(ENV));

    expect(cleanStaleGatewayProcessesSync).not.toHaveBeenCalled();
    expect(inspectPortUsage).not.toHaveBeenCalled();
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
    inspectPortUsage.mockResolvedValue({
      port: 19002,
      status: "busy",
      listeners,
      hints: [],
    });

    const result = await restartLaunchAgent(launchAgentControlFixture(env));

    expect(result).toEqual({ outcome: "completed" });
    expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(
      19002,
      expect.objectContaining({ resolveProtectedPid: expect.any(Function) }),
    );
    expect(state.cleanupProtectedPids).toEqual([managedPidAfterCleanup]);
    expect(launchctlSpawnSync).toHaveBeenCalledWith(
      "launchctl",
      ["print", SERVICE_ID],
      expect.objectContaining({
        env: expect.not.objectContaining({ BOUNDARY_PARENT_ONLY: "synthetic" }),
        timeout: 2_000,
      }),
    );
    expect(inspectPortUsage).toHaveBeenCalledWith(19002, {
      probeHosts: ["127.0.0.1"],
    });
    expect(state.launchctlCalls).toEqual([
      ["print", SERVICE_ID],
      ["print", SERVICE_ID],
      ["print", SERVICE_ID],
      ["enable", SERVICE_ID],
      ["kickstart", "-k", SERVICE_ID],
    ]);
  });

  it.each([
    {
      name: "mixed",
      listeners: [
        { pid: 4242, address: "TCP 127.0.0.1:19002 (LISTEN)" },
        { pid: 5151, address: "TCP [::1]:19002 (LISTEN)" },
      ],
    },
    {
      name: "unattributed",
      listeners: [],
    },
  ] satisfies Array<{ name: string; listeners: PortListener[] }>)(
    "rejects $name gateway port ownership before mutating launchd",
    async ({ listeners }) => {
      const env = createLaunchdEnvWithGatewayPort("19002");
      setLaunchAgentPlist(env, "ai.openclaw.gateway", ["node", "gateway.js"]);
      const plistPath = resolveLaunchAgentPlistPath(env);
      const originalPlist = state.files.get(plistPath);
      inspectPortUsage.mockResolvedValue({
        port: 19002,
        status: "busy",
        listeners,
        hints: ["Another process is listening on this port."],
      });
      formatPortDiagnostics.mockReturnValue(["Port 19002 is already in use."]);

      await expect(restartLaunchAgent(launchAgentControlFixture(env))).rejects.toThrow(
        "gateway port 19002 is busy but is not verifiably owned by LaunchAgent ai.openclaw.gateway",
      );

      expect(cleanStaleGatewayProcessesSync).toHaveBeenCalledWith(
        19002,
        expect.objectContaining({ resolveProtectedPid: expect.any(Function) }),
      );
      expect(state.cleanupProtectedPids).toEqual([4242]);
      expect(inspectPortUsage).toHaveBeenCalledWith(19002, {
        probeHosts: ["127.0.0.1"],
      });
      expect(state.launchctlCalls).toEqual([
        ["print", SERVICE_ID],
        ["print", SERVICE_ID],
        ["print", SERVICE_ID],
      ]);
      expect(state.files.get(plistPath)).toBe(originalPlist);
      expect(state.fileWrites).toHaveLength(0);
      expect(launchctlCommandNames()).not.toContain("enable");
      expect(launchctlCommandNames()).not.toContain("bootout");
      expect(launchctlCommandNames()).not.toContain("bootstrap");
      expect(launchctlCommandNames()).not.toContain("kickstart");
    },
  );

  it.each([
    ["start", "loaded", "", true],
    ["start", "loaded", "Input/output error", true],
    ["start", "stopped", "", true],
    ["start", "stopped", "Could not find service", true],
    ["start", "stopped", "Input/output error", true],
    ["start", "stopped", "Input/output error", false],
    ["start", "bootstrap-kickstart", "Could not find service", true],
    ["restart", "loaded", "", true],
    ["restart", "loaded", "Input/output error", true],
    ["restart", "stopped", "", true],
    ["restart", "stopped", "Could not find service", true],
    ["restart", "stopped", "Input/output error", true],
    ["restart", "stopped", "Input/output error", false],
    ["restart", "bootstrap-kickstart", "Could not find service", true],
  ] as const)(
    "settles %s after kickstart failure (%s, %s, preserve=%s)",
    async (action, phase, detail, preserveDefinition) => {
      if (phase !== "loaded") {
        await stopLaunchAgent(launchAgentControlFixture(ENV));
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
      async () => restartLaunchAgent(launchAgentControlFixture(ENV, { preserveDefinition: true })),
    );

    expect(result).toEqual({ outcome: "completed" });
    expect(launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff).not.toHaveBeenCalled();
    expect(launchctlCommandNames()).toEqual([
      "print",
      "enable",
      "kickstart",
      "enable",
      "bootstrap",
      "kickstart",
    ]);
    expect(state.kickstartFailuresRemaining).toBe(0);
    expect(state.serviceLoaded).toBe(true);
    expect(getSelfAndAncestorPidsSync).not.toHaveBeenCalled();
  });

  it("shows actionable guidance when launchctl gui domain does not support bootstrap", async () => {
    state.bootstrapError = "Bootstrap failed: 125: Domain does not support specified action";
    let message = "";
    try {
      await installLaunchAgent(defaultLaunchAgentFixture(ENV));
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("logged-in macOS GUI session");
    expect(message).toContain("wrong user (including sudo)");
    expect(message).toContain("https://docs.openclaw.ai/gateway");
  });
});

describe("resolveLaunchAgentPlistPath", () => {
  it("rejects invalid launchd labels that contain path separators", () => {
    expect(() =>
      resolveLaunchAgentPlistPath({
        HOME: "/Users/test",
        OPENCLAW_LAUNCHD_LABEL: "../evil/label",
      }),
    ).toThrow("Invalid launchd label");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
