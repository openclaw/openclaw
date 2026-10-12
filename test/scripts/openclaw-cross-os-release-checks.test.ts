import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection as createNetConnection, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isRecoverableWindowsPackagedUpgradeUnsettledExit } from "../../scripts/lib/cross-os-release-checks/config.ts";
import {
  agentOutputHasExpectedOkMarker,
  acquireManagedGatewayInstallerHostLease,
  buildDiscordFetchInit,
  buildPackagedUpgradeUpdateCommand,
  buildReleaseOnboardArgs,
  buildWindowsDevUpdateToolchainCheckScript,
  buildWindowsFreshShellVersionCheckScript,
  buildInstalledBrowserOverrideImportProbeScript,
  buildNpmGlobalInstallArgs,
  assertManagedGatewayInstallerHostAvailable,
  buildGatewayStopArgsFromHelpText,
  buildGatewayStatusArgsFromHelpText,
  buildInstallerSmokeScript,
  canConnectToLoopbackPort,
  dashboardHtmlMarkerStatus,
  type GatewayHandle,
  CROSS_OS_GATEWAY_READY_TIMEOUT_MS,
  CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
  CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS,
  CROSS_OS_WINDOWS_GATEWAY_READY_TIMEOUT_MS,
  CROSS_OS_DISCORD_FETCH_TIMEOUT_MS,
  deleteDiscordMessage,
  isImmutableReleaseRef,
  isRecoverableWindowsPackagedUpgradeSwapCleanupFailure,
  isRecoverableWindowsPackagedUpgradeTimeoutError,
  managedGatewayRestartCommandTimeoutMs,
  normalizeRequestedRef,
  parsePackagedUpgradeUpdateTimings,
  parsePositiveIntegerEnv,
  parseCrossOsSuiteFilter,
  parseArgs,
  parseManagedGatewayServiceInstalled,
  packageHasScript,
  prepareCandidate,
  readInstalledVersion,
  readBoundedCrossOsResponseText,
  readRunnerOverrideEnv,
  reserveGatewayPortForLane,
  resolveDashboardAssetUrls,
  runCommand,
  resolveCommandSpawnInvocation,
  resolveExplicitBaselineVersion,
  resolvePackagedUpgradeTimeouts,
  resolveInstalledCliInvocation,
  resolveInstalledPackageRootFromCliPath,
  resolveNpmDebugLogDirs,
  restartManualGatewayForDiscordSmoke,
  resolveManagedGatewayInstallerEnv,
  resolvePackDestinationTarball,
  resolveProviderConfig,
  resolveDevUpdateVerificationRef,
  resolvePublishedInstallerUrl,
  resolveRequestedSuites,
  resolveStaticFileContentType,
  startStaticFileServer,
  trimForSummary,
  shouldRunPackagedUpgradeStatusProbe,
  shouldRunWindowsInstalledBrowserOverrideImportSmoke,
  shouldRunMainChannelDevUpdate,
  shouldUseManagedGatewayService,
  verifyDashboardAssetUrls,
  verifyDevUpdateStatus,
  verifyPackagedUpgradeUpdateResult,
  verifyWindowsPackagedUpgradeFallbackInstall,
  waitForGatewayWithStartupMigrationRestart,
  writeSummary,
} from "../../scripts/lib/cross-os-release-checks/index.ts";
import * as candidateProcess from "../../scripts/lib/cross-os-release-checks/process.ts";
import { formatError } from "../../scripts/lib/cross-os-release-checks/shared.ts";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { startProcessWatchdogFixture } from "../helpers/process-watchdog.js";
import { withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { toolingTsEntrypoints } from "./tooling-ts-runtime.test-support.js";

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  // Keep native socket/stream prototypes intact across shared-worker files.
  return {
    ...actual,
    createConnection: vi.fn(actual.createConnection),
    createServer: vi.fn(actual.createServer),
  };
});

const fixtureLifetime = createFixtureLifetime();
const tempDirs = useAutoCleanupTempDirTracker((cleanupDirs) => {
  afterEach(async () => {
    // Vitest's timeout settles before the body finally; join that body before removing its inputs.
    await fixtureLifetime.cleanup();
    cleanupDirs();
  });
});
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fixtureReadyBeforeSettlement(
  pidPath: string,
  operation: PromiseLike<unknown>,
): Promise<void> {
  // The child records its PID before reporting readiness; socket delivery can trail settlement.
  const recorded = () => existsSync(pidPath) && Number(readFileSync(pidPath, "utf8")) > 1;
  const settled = Promise.resolve(operation).then(
    () => {
      if (!recorded()) {
        throw new Error(`timeout waiting for ${pidPath}`);
      }
    },
    (error: unknown) => {
      if (!recorded()) {
        throw error;
      }
    },
  );
  await Promise.race([receipts.waitFor(pidPath, "ready"), settled]);
}

// runCommand signals foreign descendants, but only joins the leader and its output streams.
async function waitForDead(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (isProcessAlive(pid)) {
      await delay(5, undefined, { signal });
    }
  } catch (error) {
    throw new Error(`process still alive: ${pid}`, { cause: error });
  }
}

function observeExit(
  child: ReturnType<typeof spawn>,
): Promise<{ signal: NodeJS.Signals | null; status: number | null }> {
  const completion = new Promise<{ signal: NodeJS.Signals | null; status: number | null }>(
    (resolvePromise, rejectPromise) => {
      child.once("close", (status, signal) => resolvePromise({ signal, status }));
      child.once("error", rejectPromise);
    },
  );
  void completion.catch(() => {});
  return completion;
}

async function captureCommand(script: string, maxOutputBytes: number) {
  const dir = tempDirs.make("openclaw-cross-os-command-");
  const logPath = join(dir, "command.log");
  const result = await runCommand(process.execPath, ["-e", script], {
    cwd: dir,
    env: process.env,
    logPath,
    maxOutputBytes,
  });
  return { ...result, log: readFileSync(logPath, "utf8") };
}

function createGatewayHandleFixture(params: {
  dir: string;
  name: string;
  beforeLaunch?: string;
  afterLaunch?: string;
  appendOnWaitForClose?: string;
  exited: boolean;
}) {
  const logPath = join(params.dir, `${params.name}.log`);
  const beforeLaunch = params.beforeLaunch ?? "";
  writeFileSync(logPath, beforeLaunch);
  if (params.afterLaunch) {
    appendFileSync(logPath, params.afterLaunch);
  }
  const state = { order: [] as string[] };
  const handle: GatewayHandle = {
    child: {
      exitCode: params.exited ? 1 : null,
      signalCode: null,
    } as GatewayHandle["child"],
    closeLog: async () => {
      state.order.push("closeLog");
    },
    launchLogOffset: Buffer.byteLength(beforeLaunch),
    logPath,
    waitForClose: async () => {
      state.order.push("waitForClose");
      if (params.appendOnWaitForClose) {
        appendFileSync(logPath, params.appendOnWaitForClose);
      }
    },
  };
  return { handle, state };
}

describe("scripts/openclaw-cross-os-release-checks", () => {
  it.each([true, false])("selects the installer account identity for managed=%s", (enabled) => {
    if (!enabled) {
      const env = { OPENCLAW_HOME: "/tmp/openclaw-installer" };
      expect(resolveManagedGatewayInstallerEnv({ env, enabled })).toBe(env);
      return;
    }
    const env = resolveManagedGatewayInstallerEnv({
      env: {
        HOME: "C:\\temp\\lane",
        USERPROFILE: "C:\\temp\\lane",
        APPDATA: "C:\\temp\\lane\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\temp\\lane\\AppData\\Local",
        OPENCLAW_HOME: "C:\\temp\\lane",
        OPENCLAW_PROFILE: "work",
        OPENCLAW_STATE_DIR: "C:\\temp\\lane\\.openclaw",
        OPENCLAW_CONFIG_PATH: "C:\\temp\\lane\\.openclaw\\openclaw.json",
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway (work)",
        OPENCLAW_TASK_SCRIPT_NAME: "work.cmd",
        OPENCLAW_TASK_SCRIPT: "C:\\temp\\work.cmd",
        OPENCLAW_SERVICE_KIND: "node",
        OpenClaw_Home: "C:\\temp\\case-variant",
        openclaw_config_path: "C:\\temp\\case-variant\\openclaw.json",
        OPENAI_API_KEY: "secret",
      },
      enabled,
      accountHome: "C:\\Users\\runneradmin",
      hostEnv: {
        APPDATA: "C:\\Users\\runneradmin\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\runneradmin\\AppData\\Local",
      },
    });

    expect(env).toMatchObject({
      HOME: "C:\\Users\\runneradmin",
      USERPROFILE: "C:\\Users\\runneradmin",
      APPDATA: "C:\\Users\\runneradmin\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\runneradmin\\AppData\\Local",
      OPENAI_API_KEY: "secret",
    });
    expect(
      Object.keys(env).filter((key) =>
        [
          "OPENCLAW_HOME",
          "OPENCLAW_PROFILE",
          "OPENCLAW_STATE_DIR",
          "OPENCLAW_CONFIG_PATH",
          "OPENCLAW_WINDOWS_TASK_NAME",
          "OPENCLAW_TASK_SCRIPT_NAME",
          "OPENCLAW_TASK_SCRIPT",
          "OPENCLAW_SERVICE_KIND",
        ].includes(key.toUpperCase()),
      ),
    ).toEqual([]);
  });

  it("fails closed before borrowing an occupied managed-service account", () => {
    expect(() =>
      assertManagedGatewayInstallerHostAvailable({
        accountHome: "C:\\Users\\runneradmin",
        serviceInstalled: true,
        pathExists: () => false,
      }),
    ).toThrow(/pristine host account/);
    expect(() =>
      assertManagedGatewayInstallerHostAvailable({
        accountHome: "C:\\Users\\runneradmin",
        serviceInstalled: false,
        pathExists: (path) => path.endsWith(".openclaw"),
      }),
    ).toThrow(/pristine host account/);
  });

  it("requires a structured clean-service preflight result", () => {
    expect(
      parseManagedGatewayServiceInstalled({
        exitCode: 0,
        stdout: JSON.stringify({ service: { loaded: false } }),
        stderr: "",
      }),
    ).toBe(false);
    expect(() =>
      parseManagedGatewayServiceInstalled({
        exitCode: 1,
        stdout: "",
        stderr: "status failed",
      }),
    ).toThrow(/exit code 1/);
  });

  it("holds an exclusive managed-service host lease until release", () => {
    const accountHome = tempDirs.make("openclaw-managed-host-");
    const lease = acquireManagedGatewayInstallerHostLease(accountHome);

    expect(() => acquireManagedGatewayInstallerHostLease(accountHome)).toThrow(/exclusive access/);
    lease.release();
    const replacement = acquireManagedGatewayInstallerHostLease(accountHome);
    replacement.release();
  });

  it("bounds public installer fetches on Windows and POSIX", () => {
    const windowsScript = buildInstallerSmokeScript({
      installerUrl: "https://openclaw.ai/install.ps1",
      installTarget: "2026.7.1",
      platform: "win32",
    });
    const posixScript = buildInstallerSmokeScript({
      installerUrl: "https://openclaw.ai/install.sh",
      installTarget: "2026.7.1",
      platform: "linux",
    });

    expect(windowsScript).toContain(
      "curl.exe -fsSL --connect-timeout 10 --max-time 120 -o $installerPath 'https://openclaw.ai/install.ps1'",
    );
    expect(windowsScript).toContain("openclaw-installer-");
    expect(windowsScript).toContain("if ($LASTEXITCODE -ne 0)");
    expect(windowsScript).toContain(
      "[System.IO.File]::ReadAllText($installerPath, [System.Text.Encoding]::UTF8)",
    );
    expect(windowsScript).toContain(
      "Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue",
    );
    expect(windowsScript).not.toContain("Invoke-WebRequest");
    expect(posixScript).toContain(
      'installer_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-installer-XXXXXX")"',
    );
    expect(posixScript).toContain("trap 'rm -f \"$installer_path\"' EXIT");
    expect(posixScript).toContain(
      "curl -fsSL --connect-timeout 10 --max-time 120 -o \"$installer_path\" 'https://openclaw.ai/install.sh'",
    );
    expect(posixScript).toContain("bash -- \"$installer_path\" --version '2026.7.1' --no-onboard");
    expect(posixScript).not.toContain("| bash");
    expect(posixScript).toContain("set -euo pipefail");
  });

  it("drops split surrogate pairs when truncating response bodies", async () => {
    await expect(readBoundedCrossOsResponseText(new Response("abc😀tail"), 4)).resolves.toBe(
      "abc\n[truncated]",
    );
  });

  it("drops split surrogate pairs when truncating summaries", () => {
    expect(trimForSummary(`${"x".repeat(599)}😀tail`)).toBe(`${"x".repeat(599)}...`);
  });

  it("names every inner failure of a lane AggregateError within the summary", () => {
    const cleanup = new AggregateError(
      [new Error("schtasks /End failed"), new Error("host lease release failed")],
      "Managed-service cleanup and host-lease release both failed.",
    );
    const error = new AggregateError(
      [new Error("Command timed out: openclaw gateway stop --help"), cleanup],
      "Installer release check and managed-service cleanup both failed.",
    );

    const summary = trimForSummary(formatError(error));
    for (const message of [
      "Installer release check and managed-service cleanup both failed.",
      "Command timed out: openclaw gateway stop --help",
      "schtasks /End failed",
      "host lease release failed",
    ]) {
      expect(summary).toContain(message);
    }
  });

  it("keeps cross-OS fetch timeouts active while reading response bodies", async () => {
    let canceled = false;
    const abortController = new AbortController();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
        },
        cancel() {
          canceled = true;
        },
      }),
    );

    const text = readBoundedCrossOsResponseText(response, 1024, {
      signal: abortController.signal,
    });

    await delay(0);
    abortController.abort(new Error("cross-os body timed out"));

    await expect(text).rejects.toThrow("cross-os body timed out");
    expect(canceled).toBe(true);
  });

  it("requires dashboard root markers and same-origin asset URLs", () => {
    const html = [
      "<title>OpenClaw Control</title>",
      "<openclaw-app></openclaw-app>",
      '<link rel="stylesheet" href="/assets/index.css">',
      '<script type="module" src="assets/index.js"></script>',
      '<script type="module" src="https://example.com/assets/ignored.js"></script>',
    ].join("\n");

    expect(dashboardHtmlMarkerStatus(html)).toEqual({ app: true, ready: true, title: true });
    expect(resolveDashboardAssetUrls("http://127.0.0.1:18789/", html)).toEqual([
      "http://127.0.0.1:18789/assets/index.css",
      "http://127.0.0.1:18789/assets/index.js",
    ]);
  });

  it("fails dashboard readiness when assets are missing or unreachable", async () => {
    await expect(verifyDashboardAssetUrls([])).resolves.toEqual({
      failures: ["no dashboard asset URLs found"],
      ok: false,
    });

    const result = await verifyDashboardAssetUrls(
      ["http://127.0.0.1:18789/assets/index.css", "http://127.0.0.1:18789/assets/index.js"],
      async (url) =>
        new Response("", {
          status: (url instanceof Request ? url.url : url.toString()).endsWith(".js") ? 404 : 200,
        }),
    );

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(["http://127.0.0.1:18789/assets/index.js status=404"]);
  });

  it("keeps gateway RPC status probes patient enough for live release startup", () => {
    expect(CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS).toBeGreaterThan(
      CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS,
    );
    expect(CROSS_OS_GATEWAY_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
    expect(CROSS_OS_WINDOWS_GATEWAY_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
    expect(managedGatewayRestartCommandTimeoutMs("win32")).toBeGreaterThan(
      CROSS_OS_WINDOWS_GATEWAY_READY_TIMEOUT_MS,
    );
    expect(managedGatewayRestartCommandTimeoutMs("linux")).toBeGreaterThan(
      CROSS_OS_GATEWAY_READY_TIMEOUT_MS,
    );
  });

  it("keeps gateway status RPC probing when help probing is unavailable", () => {
    expect(buildGatewayStatusArgsFromHelpText("--require-rpc")).toEqual([
      "gateway",
      "status",
      "--require-rpc",
      "--timeout",
      String(CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS),
    ]);
    expect(buildGatewayStatusArgsFromHelpText("Usage: openclaw gateway status")).toEqual([
      "gateway",
      "status",
    ]);
    expect(
      buildGatewayStatusArgsFromHelpText("--require-rpc", {
        requireRpc: false,
      }),
    ).toEqual(["gateway", "status"]);
  });

  it.each(["recovered", "stale", "live", "repeated"] as const)(
    "bounds startup-migration restarts: %s",
    async (scenario) => {
      const dir = tempDirs.make("openclaw-cross-os-gateway-restart-");
      const refusal =
        "OpenClaw plugin migration inputs changed during startup convergence; refusing to report the gateway ready.\n";
      const first = createGatewayHandleFixture({
        dir,
        name: "first",
        beforeLaunch: scenario === "stale" ? refusal : "",
        appendOnWaitForClose: scenario === "recovered" ? refusal : "",
        afterLaunch:
          scenario === "stale"
            ? refusal.replace(";", ":")
            : scenario === "recovered"
              ? ""
              : refusal,
        exited: scenario !== "live",
      });
      const second = createGatewayHandleFixture({
        dir,
        name: "second",
        afterLaunch: refusal,
        exited: scenario === "repeated",
      });
      const holder: { current: GatewayHandle | null } = { current: first.handle };
      const firstError = new Error("first gateway failed readiness");
      const secondError = new Error("second gateway exited");
      const restartGateway = vi.fn(async () => second.handle);
      const ready = waitForGatewayWithStartupMigrationRestart({
        gatewayHolder: holder,
        restartGateway,
        waitUntilReady: async (gateway) => {
          if (gateway === first.handle) {
            throw firstError;
          }
          if (scenario === "repeated") {
            throw secondError;
          }
        },
      });
      if (scenario === "recovered") {
        await ready;
      } else {
        await expect(ready).rejects.toBe(scenario === "repeated" ? secondError : firstError);
      }
      const restarted = scenario === "recovered" || scenario === "repeated";
      expect(restartGateway).toHaveBeenCalledTimes(restarted ? 1 : 0);
      expect(holder.current).toBe(restarted ? second.handle : first.handle);
      expect(first.state.order).toEqual(scenario === "live" ? [] : ["waitForClose", "closeLog"]);
      expect(second.state.order).toEqual(
        scenario === "repeated" ? ["waitForClose", "closeLog"] : [],
      );
    },
  );

  it("routes the Discord manual relaunch through the bounded retry wait", async () => {
    const dir = tempDirs.make("openclaw-cross-os-discord-gateway-");
    const previous = createGatewayHandleFixture({
      dir,
      name: "previous",
      exited: false,
    });
    const started = createGatewayHandleFixture({
      dir,
      name: "started",
      exited: false,
    });
    const lane = {
      name: "installer-fresh",
      rootDir: dir,
      prefixDir: join(dir, "prefix"),
      homeDir: join(dir, "home"),
      stateDir: join(dir, "state"),
      appDataDir: join(dir, "app-data"),
      gatewayPort: 18_789,
      phaseTimings: [],
    };
    const gatewayHolder = { current: previous.handle as GatewayHandle | null };
    const gatewayLogPath = join(dir, "discord-gateway.log");
    const statusLogPath = join(dir, "discord-status.log");
    const calls: Array<{ name: string; params: unknown }> = [];

    await restartManualGatewayForDiscordSmoke({
      lane,
      cliPath: join(dir, "openclaw"),
      env: { OPENCLAW_HOME: lane.homeDir },
      gatewayHolder,
      gatewayLogPath,
      statusLogPath,
      operations: {
        stopGateway: async (gateway) => {
          calls.push({ name: "stop", params: gateway });
        },
        startGateway: async (params) => {
          calls.push({ name: "start", params });
          return started.handle;
        },
        waitForGateway: async (params) => {
          calls.push({ name: "wait", params });
        },
      },
    });

    expect(gatewayHolder.current).toBe(started.handle);
    expect(calls.map((call) => call.name)).toEqual(["stop", "start", "wait"]);
    expect(calls[2]?.params).toMatchObject({
      gatewayHolder,
      gatewayLogPath,
      logPath: statusLogPath,
    });
  });

  it.each([
    [800_000, 1200, 2_520_000],
    [Number.NaN, 600, 1_320_000],
  ])(
    "sizes Windows upgrade budgets from a %d ms baseline install",
    (durationMs, stepTimeoutSeconds, wrapperTimeoutMs) => {
      expect(resolvePackagedUpgradeTimeouts(durationMs, "win32")).toEqual({
        stepTimeoutSeconds,
        wrapperTimeoutMs,
      });
      expect(resolvePackagedUpgradeTimeouts(durationMs, "linux")).toEqual({
        stepTimeoutSeconds: 1200,
        wrapperTimeoutMs: 1_200_000,
      });
    },
  );

  it("rejects malformed cross-OS positive integer environment values", () => {
    expect(parsePositiveIntegerEnv("OPENCLAW_CROSS_OS_COMMAND_HEARTBEAT_SECONDS", 60, {})).toBe(60);
    expect(
      parsePositiveIntegerEnv("OPENCLAW_CROSS_OS_COMMAND_HEARTBEAT_SECONDS", 60, {
        OPENCLAW_CROSS_OS_COMMAND_HEARTBEAT_SECONDS: "25",
      }),
    ).toBe(25);

    for (const raw of ["1e3", "25ms", "1.5", "0", "-1", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() =>
        parsePositiveIntegerEnv("OPENCLAW_CROSS_OS_COMMAND_HEARTBEAT_SECONDS", 60, {
          OPENCLAW_CROSS_OS_COMMAND_HEARTBEAT_SECONDS: raw,
        }),
      ).toThrow("OPENCLAW_CROSS_OS_COMMAND_HEARTBEAT_SECONDS must be a positive integer");
    }
  });

  it.each([
    {
      name: "retains bounded allowlisted timings",
      inputs: [
        JSON.stringify({
          durationMs: 622_000,
          root: String.raw`C:\private\openclaw`,
          steps: [
            {
              name: "global update",
              command: "npm install --global secret-package",
              cwd: String.raw`C:\private\prefix`,
              durationMs: 461_000,
            },
            { name: "global install swap", durationMs: 39_000 },
            { name: "openclaw doctor", durationMs: 66_000 },
            { name: "unknown internal step", durationMs: 123_000 },
          ],
        }),
      ],
      expected: [
        { name: "total", durationMs: 622_000 },
        { name: "package-install", durationMs: 461_000 },
        { name: "staged-swap", durationMs: 39_000 },
        { name: "doctor", durationMs: 66_000 },
      ],
    },
    {
      name: "drops malformed, unsafe, and out-of-bounds timings",
      inputs: [
        "not json",
        "[]",
        JSON.stringify({
          durationMs: 3_600_001,
          steps: [
            { name: "global update", durationMs: -1 },
            { name: "global install swap", durationMs: 1.5 },
            { name: "openclaw doctor", durationMs: "66000" },
          ],
        }),
      ],
      expected: [],
    },
  ])("$name", ({ inputs, expected }) => {
    for (const input of inputs) {
      expect(parsePackagedUpgradeUpdateTimings(input)).toEqual(expected);
    }
  });

  it("renders runner, runtime, and sanitized updater timing evidence", () => {
    const dir = tempDirs.make("openclaw-cross-os-summary-");
    writeSummary(dir, {
      platform: "win32",
      runnerOs: "Windows",
      runnerLabel: "blacksmith-32vcpu-windows-2025",
      nodeVersion: "v24.15.0",
      npmVersion: "11.8.0",
      provider: "openai",
      suite: "packaged-upgrade",
      mode: "upgrade",
      sourceSha: "abc123",
      candidateVersion: "2026.8.28-beta.1",
      baselineSpec: "openclaw@2026.8.27",
      result: {
        status: "pass",
        updateFallback: {
          reason: "timeout",
          action: "direct-candidate-install",
        },
        updateTimings: [
          { name: "total", durationMs: 622_000 },
          { name: "package-install", durationMs: 461_000 },
        ],
      },
    });

    const json = readFileSync(join(dir, "summary.json"), "utf8");
    const markdown = readFileSync(join(dir, "summary.md"), "utf8");
    expect(json).toContain('"runnerLabel": "blacksmith-32vcpu-windows-2025"');
    expect(markdown).toContain("- Runner: `blacksmith-32vcpu-windows-2025`");
    expect(markdown).toContain("- Node: `v24.15.0`");
    expect(markdown).toContain("- npm: `11.8.0`");
    expect(markdown).toContain("- Updater fallback: `timeout/direct-candidate-install`");
    expect(markdown).toContain("- `package-install`: 461s");
    expect(markdown).not.toContain("private");
    expect(markdown).not.toContain("npm install");
  });

  it.each([
    {
      name: "accepts captured OK output when stdout is empty",
      lines: [
        "2026-04-24T15:00:00.000Z command stdout",
        JSON.stringify({
          finalAssistantVisibleText: "OK",
          payloads: [{ type: "text", text: "OK" }],
        }),
      ],
      expected: true,
    },
    {
      name: "ignores stale OK markers outside the recent tail",
      lines: [
        JSON.stringify({ payloads: [{ type: "text", text: "OK" }] }),
        "x".repeat(2_200_000),
        JSON.stringify({ payloads: [{ type: "text", text: "still working" }] }),
      ],
      expected: false,
    },
  ])("$name", ({ lines, expected }) => {
    const logPath = join(tempDirs.make("openclaw-cross-os-agent-output-"), "agent.log");
    writeFileSync(logPath, lines.join("\n"));
    expect(agentOutputHasExpectedOkMarker("", { logPath })).toBe(expected);
  });

  it("allows cross-OS provider smoke models to use faster CI overrides", () => {
    expect(
      resolveProviderConfig("openai", {
        OPENCLAW_CROSS_OS_OPENAI_MODEL: "openai/gpt-5.4-mini",
      })?.model,
    ).toBe("openai/gpt-5.4-mini");
    expect(
      resolveProviderConfig("openai", {
        OPENCLAW_CROSS_OS_MODEL: "openai/gpt-5.4-nano",
      })?.model,
    ).toBe("openai/gpt-5.4-nano");
    expect(resolveProviderConfig("openai", {})?.model).toBe("openai/gpt-5.6-luna");
    expect(resolveProviderConfig("openai", {})?.requiredCompanionPackages).toEqual([
      "@openclaw/codex",
    ]);
    expect(resolveProviderConfig("anthropic", {})?.requiredCompanionPackages).toEqual([]);
    expect(resolveProviderConfig("minimax", {})?.requiredCompanionPackages).toEqual([]);
  });

  it("can stage packaged-upgrade baselines without npm lifecycle scripts", () => {
    expect(buildNpmGlobalInstallArgs("openclaw@2026.5.2", { ignoreScripts: true })).toEqual([
      "install",
      "-g",
      "openclaw@2026.5.2",
      "--omit=dev",
      "--no-fund",
      "--no-audit",
      "--ignore-scripts",
      "--loglevel=notice",
    ]);
  });

  it.each([true, false])("admits only safe pnpm pack destinations: safe=%s", (safe) => {
    const packDir = resolvePath("/tmp/openclaw-pack");
    const filenames = safe
      ? ["openclaw-2026.6.17.tgz", resolvePath(packDir, "openclaw-2026.6.17.tgz")]
      : [
          "../openclaw.tgz",
          "nested/openclaw.tgz",
          "nested\\openclaw.tgz",
          resolvePath(dirname(packDir), "openclaw.tgz"),
          resolvePath(packDir, "nested", "openclaw.tgz"),
          "openclaw\u0000.tgz",
          "openclaw.tar.gz",
        ];
    for (const filename of filenames) {
      const resolve = () => resolvePackDestinationTarball(filename, packDir, "pnpm pack");
      if (safe) {
        expect(resolve()).toEqual({
          fileName: "openclaw-2026.6.17.tgz",
          path: resolvePath(packDir, "openclaw-2026.6.17.tgz"),
        });
      } else {
        expect(resolve).toThrow("pnpm pack did not report a safe .tgz filename.");
      }
    }
  });

  it("prepares source-owned package inventory for isolated candidates", async () => {
    const sourceDir = tempDirs.make("openclaw-cross-os-prepare-package-");
    const outputDir = join(sourceDir, "out");
    const logsDir = join(sourceDir, "logs");
    const helperPath = join(sourceDir, "scripts", "package-openclaw-for-docker.mjs");
    const inventoryPath = join(sourceDir, "dist", "postinstall-inventory.json");
    const candidateTgz = join(outputDir, "package", "openclaw-2026.9.1.tgz");
    const sourceSha = "a".repeat(40);
    mkdirSync(dirname(helperPath), { recursive: true });
    mkdirSync(dirname(inventoryPath), { recursive: true });
    writeFileSync(
      join(sourceDir, "CHANGELOG.md"),
      "# Changelog\n\n## 2026.9.1\n\n- Preserve source-owned inventory during candidate packaging.\n",
    );
    writeFileSync(join(sourceDir, "pnpm-workspace.yaml"), "nodeLinker: isolated\n");
    writeFileSync(
      join(sourceDir, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.9.1",
        bundleDependencies: ["fixture-runtime"],
      }),
    );
    writeFileSync(helperPath, "export {};\n");
    const commands = vi
      .spyOn(candidateProcess, "runCommand")
      .mockImplementation(async (_, args) => {
        let stdout = "";
        if (args[0] === "rev-parse") {
          stdout = sourceSha;
        } else if (args[0] === helperPath) {
          writeFileSync(inventoryPath, JSON.stringify(["dist/from-source-helper.js"]));
          writeFileSync(candidateTgz, "fixture tarball");
          stdout = `${candidateTgz}\n`;
        } else if (args[0] === "pack") {
          throw new Error('bundleDependencies does not work with "nodeLinker: isolated"');
        }
        return { exitCode: 0, stdout, stderr: "" };
      });
    try {
      const candidate = await prepareCandidate({ sourceDir, outputDir, logsDir });

      expect(candidate).toMatchObject({
        sourceSha,
        candidateTgz,
        candidateVersion: "2026.9.1",
      });
      expect(JSON.parse(readFileSync(inventoryPath, "utf8"))).toEqual([
        "dist/from-source-helper.js",
      ]);
      expect(commands.mock.calls.filter(([, args]) => args[0] === "pack")).toHaveLength(0);
      expect(commands.mock.calls.filter(([, args]) => args[0] === helperPath)).toHaveLength(1);
    } finally {
      commands.mockRestore();
    }
  });

  it.each([
    {
      label: "stable predecessor",
      baselineVersion: "2026.8.32",
      candidateVersion: "2026.8.34",
      timeoutSeconds: undefined,
      expectedArgs: [
        "update",
        "--tag",
        "http://127.0.0.1:49152/openclaw-current.tgz",
        "--yes",
        "--json",
        "--no-restart",
        "--timeout",
        process.platform === "win32" ? "600" : "1200",
      ],
      expectedPackageSpec: undefined,
      expectedNpmTag: undefined,
    },
    {
      label: "extended-stable predecessor and candidate",
      baselineVersion: "2026.8.33",
      candidateVersion: "2026.8.34",
      timeoutSeconds: 1200,
      expectedArgs: ["update", "--yes", "--json", "--no-restart", "--timeout", "1200"],
      expectedPackageSpec: "openclaw",
      expectedNpmTag: "extended-stable",
    },
    {
      label: "extended-stable predecessor and regular candidate",
      baselineVersion: "2026.8.33",
      candidateVersion: "2026.9.1",
      timeoutSeconds: 1200,
      expectedArgs: [
        "update",
        "--tag",
        "http://127.0.0.1:49152/openclaw-current.tgz",
        "--yes",
        "--json",
        "--no-restart",
        "--timeout",
        "1200",
      ],
      expectedPackageSpec: undefined,
      expectedNpmTag: undefined,
    },
  ])("routes packaged upgrades from the $label channel", (testCase) => {
    const candidateUrl = "http://127.0.0.1:49152/openclaw-current.tgz";
    const updateCommand = buildPackagedUpgradeUpdateCommand({
      env: {
        NPM_CONFIG_REGISTRY: "http://127.0.0.1:49152",
        FOO: "bar",
        NODE_COMPILE_CACHE: "/tmp/stale-openclaw-cache",
        OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: "1",
      },
      candidateUrl,
      candidateVersion: testCase.candidateVersion,
      timeoutSeconds: testCase.timeoutSeconds,
      baselineVersion: testCase.baselineVersion,
    });
    expect(updateCommand.args).toEqual(testCase.expectedArgs);
    expect(updateCommand.env.OPENCLAW_UPDATE_PACKAGE_SPEC).toBe(testCase.expectedPackageSpec);
    expect(updateCommand.env.NPM_CONFIG_TAG).toBe(testCase.expectedNpmTag);
    expect(updateCommand.env).toEqual({
      NPM_CONFIG_REGISTRY: "http://127.0.0.1:49152",
      FOO: "bar",
      OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
      ...(testCase.expectedPackageSpec
        ? {
            OPENCLAW_UPDATE_PACKAGE_SPEC: testCase.expectedPackageSpec,
            NPM_CONFIG_TAG: testCase.expectedNpmTag,
          }
        : {}),
    });
  });

  it("uses forced shutdown only when the installed gateway supports it", () => {
    expect(buildGatewayStopArgsFromHelpText("--force  Skip confirmation")).toEqual([
      "gateway",
      "stop",
      "--force",
    ]);
    expect(buildGatewayStopArgsFromHelpText("--disable  Disable the service")).toEqual([
      "gateway",
      "stop",
    ]);
  });

  it("treats explicit empty-string args as values instead of boolean flags", () => {
    expect(parseArgs(["--ubuntu-runner", "", "--mode", "both"])).toEqual({
      "ubuntu-runner": "",
      mode: "both",
    });
  });

  it("normalizes full Git refs before suite and update decisions", () => {
    expect(normalizeRequestedRef(" refs/heads/main ")).toBe("main");
    expect(normalizeRequestedRef("refs/tags/v2026.4.14")).toBe("v2026.4.14");
    expect(isImmutableReleaseRef("refs/tags/test-tag")).toBe(true);
    expect(resolveRequestedSuites("both", "refs/tags/v2026.4.14")).toEqual([
      "packaged-fresh",
      "installer-fresh",
      "packaged-upgrade",
    ]);
    expect(resolveRequestedSuites("both", "refs/tags/test-tag")).toEqual([
      "packaged-fresh",
      "installer-fresh",
      "packaged-upgrade",
    ]);
    expect(shouldRunMainChannelDevUpdate("refs/heads/main")).toBe(true);
    expect(shouldRunMainChannelDevUpdate("refs/tags/main")).toBe(false);
  });

  it.each([
    {
      name: "skips dev-update for non-main branch validation refs",
      input: "codex/cross-os-release-checks",
      expected: ["packaged-fresh", "installer-fresh", "packaged-upgrade"],
    },
    {
      name: "keeps dev-update enabled for main validation refs",
      input: "main",
      expected: ["packaged-fresh", "installer-fresh", "packaged-upgrade", "dev-update"],
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveRequestedSuites("both", input)).toEqual(expected);
  });

  it("preflights standalone source candidates before cross-OS dependency installation", async () => {
    const root = tempDirs.make("openclaw-cross-os-source-preflight-");
    const sourceDir = join(root, "source");
    const logsDir = join(root, "logs");
    const outputDir = join(root, "output");
    mkdirSync(join(sourceDir, "packages", "ai"), { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.8.1",
        dependencies: {
          "@openclaw/ai": "workspace:*",
          "partial-json": "0.1.8",
        },
      }),
    );
    writeFileSync(
      join(sourceDir, "packages", "ai", "package.json"),
      JSON.stringify({
        name: "@openclaw/ai",
        version: "2026.8.1",
        dependencies: {
          "partial-json": "0.1.7",
        },
      }),
    );
    writeFileSync(
      join(sourceDir, "CHANGELOG.md"),
      "# Changelog\n\n## Unreleased\n\n- Validate source metadata before installing dependencies.\n",
    );

    await expect(prepareCandidate({ logsDir, outputDir, sourceDir })).rejects.toThrow(
      "package.json must declare partial-json@0.1.7",
    );
    expect(existsSync(join(logsDir, "pnpm-install.log"))).toBe(false);
  });

  it("rejects unsupported cross-OS suite filter tokens", () => {
    expect(() => parseCrossOsSuiteFilter("windows/nope")).toThrow(
      /Unsupported cross_os_suite_filter/u,
    );
  });

  it("prefers the freshly installed Windows CLI under npm's prefix before PATH lookup", () => {
    const script = buildWindowsFreshShellVersionCheckScript({
      expectedNeedle: "2026.4.14",
    });
    expect(script).toContain("foreach ($candidate in @($env:Path, $userPath, $machinePath))");
    expect(script).toContain("Get-Command npm.cmd -ErrorAction SilentlyContinue");
    expect(script).toContain('$env:Path = "$npmPrefix;$env:Path"');
    expect(script).toContain("(Join-Path $npmPrefix 'openclaw.cmd')");
    expect(script).toContain("$cmd = Get-Command openclaw -ErrorAction Stop");
  });

  it("keeps Windows dev-update toolchain checks compatible with setup-node PATH shims", () => {
    const script = buildWindowsDevUpdateToolchainCheckScript();
    expect(script).toContain("foreach ($candidate in @($env:Path, $userPath, $machinePath))");
    expect(script).toContain("$pnpmPath = Resolve-CommandPath 'pnpm'");
    expect(script).toContain("$corepackPath = Resolve-CommandPath 'corepack'");
    expect(script).toContain("$npmPath = Resolve-CommandPath 'npm'");
  });

  it.each([
    { source: "workflow", primary: ["workflow-linux", "workflow-windows", "workflow-macos"] },
    { source: "legacy", primary: ["", " ", ""] },
  ])("uses $source runner overrides", ({ source, primary }) => {
    expect(
      readRunnerOverrideEnv({
        VAR_UBUNTU_RUNNER: primary[0],
        VAR_WINDOWS_RUNNER: primary[1],
        VAR_MACOS_RUNNER: primary[2],
        OPENCLAW_RELEASE_CHECKS_UBUNTU_RUNNER: "legacy-linux",
        OPENCLAW_RELEASE_CHECKS_WINDOWS_RUNNER: "legacy-windows",
        OPENCLAW_RELEASE_CHECKS_MACOS_RUNNER: "legacy-macos",
      }),
    ).toEqual({
      varUbuntuRunner: `${source}-linux`,
      varWindowsRunner: `${source}-windows`,
      varMacosRunner: `${source}-macos`,
    });
  });

  it("serves installer scripts as UTF-8 text and package payloads as binary", () => {
    expect(resolveStaticFileContentType("scripts/install.sh")).toBe("text/plain; charset=utf-8");
    expect(resolveStaticFileContentType("scripts/install.ps1")).toBe("text/plain; charset=utf-8");
    expect(resolveStaticFileContentType("openclaw-2026.4.14.tgz")).toBe("application/octet-stream");
  });

  it.each([
    {
      fileName: "openclaw release-🦞#.tgz",
      requestPath: "/openclaw%20release-%F0%9F%A6%9E%23.tgz",
    },
  ])(
    "streams release artifacts from the static file server: $fileName",
    async ({ fileName, requestPath }) => {
      const dir = tempDirs.make("openclaw-cross-os-static-server-");
      const filePath = join(dir, fileName);
      const logPath = join(dir, "server.log");
      let server: Awaited<ReturnType<typeof startStaticFileServer>> | undefined;

      try {
        const payload = Buffer.from(`artifact-head\n${"x".repeat(1024 * 1024)}\nartifact-tail`);
        writeFileSync(filePath, payload);

        server = await startStaticFileServer({ filePath, logPath });
        const response = await fetch(server.url);
        const body = Buffer.from(await response.arrayBuffer());

        expect(response.status).toBe(200);
        expect(response.headers.get("content-length")).toBe(String(payload.length));
        expect(response.headers.get("content-type")).toBe("application/octet-stream");
        expect(body.equals(payload)).toBe(true);
        await server.close();
        expect(readFileSync(logPath, "utf8")).toContain(`GET ${requestPath}`);
      } finally {
        await server?.close();
      }
    },
  );

  it("closes static release artifact sockets left by aborted clients", async () => {
    const dir = tempDirs.make("openclaw-cross-os-static-server-close-");
    const filePath = join(dir, "openclaw-2026.4.14.tgz");
    const logPath = join(dir, "server.log");
    let server: Awaited<ReturnType<typeof startStaticFileServer>> | undefined;

    try {
      writeFileSync(filePath, Buffer.alloc(1024 * 1024, "x"));
      server = await startStaticFileServer({ filePath, logPath });
      const url = new URL(server.url);
      const socket = createNetConnection(Number(url.port), url.hostname);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      // Subscribe before shutdown because the one-shot client close event may
      // arrive before the server close callback resolves.
      const socketClosePromise = new Promise<void>((resolve) => {
        socket.once("close", resolve);
      });
      socket.write(`GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`);
      await Promise.race([
        server.close(),
        delay(1_000, undefined, { ref: false }).then(() => {
          throw new Error("close timed out");
        }),
      ]);
      await Promise.race([
        socketClosePromise,
        delay(1_000, undefined, { ref: false }).then(() => {
          throw new Error("socket close timed out");
        }),
      ]);
    } finally {
      await server?.close().catch(() => {});
    }
  });

  it("flushes static release artifact logs before close resolves", async () => {
    const dir = tempDirs.make("openclaw-cross-os-static-server-log-flush-");
    const filePath = join(dir, "openclaw-2026.4.14.tgz");
    const logPath = join(dir, "server.log");
    let server: Awaited<ReturnType<typeof startStaticFileServer>> | undefined;

    try {
      writeFileSync(filePath, Buffer.alloc(128, "x"));
      server = await startStaticFileServer({ filePath, logPath });
      const marker = `flush-${"x".repeat(512)}-done`;

      for (let index = 0; index < 8; index += 1) {
        const response = await fetch(`${server.url}?${marker}-${index}`);
        await response.text();
      }
      await server.close();
      server = undefined;

      expect(readFileSync(logPath, "utf8")).toContain(`${marker}-7`);
    } finally {
      await server?.close().catch(() => {});
    }
  });

  it("does not preload static release artifacts before serving them", () => {
    const source = readFileSync("scripts/lib/cross-os-release-checks/process.ts", "utf8");
    const serverSource = source.slice(
      source.indexOf("export async function startStaticFileServer"),
      source.indexOf("export function resolveStaticFileContentType"),
    );

    expect(serverSource).toContain("createReadStream(params.filePath)");
    expect(serverSource).not.toContain("readFileSync(params.filePath)");
  });

  it.each([
    {
      name: "uses the published installer URLs for native installer lanes",
      decide: resolvePublishedInstallerUrl,
      inputs: ["darwin", "linux", "win32"] as const,
      expected: [
        "https://openclaw.ai/install.sh",
        "https://openclaw.ai/install.sh",
        "https://openclaw.ai/install.ps1",
      ],
    },
    {
      name: "uses managed gateway services only on native Windows runners",
      decide: shouldUseManagedGatewayService,
      inputs: ["win32", "darwin", "linux"] as const,
      expected: [true, false, false],
    },
  ])("$name", ({ decide, inputs, expected }) => {
    expect(inputs.map((platform) => decide(platform))).toEqual(expected);
  });

  it("skips workspace bootstrap during release onboarding", () => {
    expect(
      buildReleaseOnboardArgs({
        authChoice: "openai-api-key",
        gatewayPort: 34111,
        skipHealth: true,
      }),
    ).toEqual([
      "onboard",
      "--non-interactive",
      "--mode",
      "local",
      "--auth-choice",
      "openai-api-key",
      "--secret-input-mode",
      "ref",
      "--gateway-port",
      "34111",
      "--gateway-bind",
      "loopback",
      "--skip-skills",
      "--skip-bootstrap",
      "--accept-risk",
      "--json",
      "--skip-health",
    ]);
  });

  it("runs the installed browser override import smoke only on native Windows", () => {
    expect(shouldRunWindowsInstalledBrowserOverrideImportSmoke("win32")).toBe(true);
    expect(shouldRunWindowsInstalledBrowserOverrideImportSmoke("darwin")).toBe(false);
    expect(shouldRunWindowsInstalledBrowserOverrideImportSmoke("linux")).toBe(false);

    const script = buildInstalledBrowserOverrideImportProbeScript();
    expect(script).toContain('from "openclaw/plugin-sdk/plugin-runtime"');
    expect(script).toContain('overrideEnvVar: "OPENCLAW_BROWSER_CONTROL_MODULE"');
    expect(script).toContain("startBrowserControlService");
    expect(script).toContain("stopBrowserControlService");
    expect(script).toContain("Browser control override start sentinel was not written.");

    const installedScript = buildInstalledBrowserOverrideImportProbeScript(
      "file:///C:/Users/runner/AppData/Roaming/npm/node_modules/openclaw/dist/plugin-sdk/plugin-runtime.js",
    );
    expect(installedScript).toContain(
      'from "file:///C:/Users/runner/AppData/Roaming/npm/node_modules/openclaw/dist/plugin-sdk/plugin-runtime.js"',
    );
    expect(readFileSync("scripts/lib/cross-os-release-checks/install.ts", "utf8")).toContain(
      "OPENCLAW_BROWSER_CONTROL_MODULE: pathToFileURL(overridePath).href",
    );
  });

  it("does not trust ambient ComSpec when wrapping Windows cmd shims", () => {
    const originalComSpec = process.env.ComSpec;
    const originalSystemRoot = process.env.SystemRoot;
    try {
      process.env.ComSpec = String.raw`C:\Users\test\bin\cmd.exe`;
      process.env.SystemRoot = String.raw`D:\Windows`;

      expect(
        resolveCommandSpawnInvocation(String.raw`C:\Program Files\nodejs\npm.cmd`, ["--version"], {
          platform: "win32",
        }).command,
      ).toBe(String.raw`D:\Windows\System32\cmd.exe`);
    } finally {
      if (originalComSpec === undefined) {
        delete process.env.ComSpec;
      } else {
        process.env.ComSpec = originalComSpec;
      }
      if (originalSystemRoot === undefined) {
        delete process.env.SystemRoot;
      } else {
        process.env.SystemRoot = originalSystemRoot;
      }
    }
  });

  it("wraps installed Windows CLI cmd fallbacks without Node shell argv", () => {
    expect(
      resolveInstalledCliInvocation(
        win32.join(String.raw`C:\OpenClaw Prefix`, "openclaw.ps1"),
        ["gateway", "run", "--port", "1234"],
        {
          comSpec: String.raw`C:\Windows\System32\cmd.exe`,
          platform: "win32",
        },
      ),
    ).toEqual({
      command: String.raw`C:\Windows\System32\cmd.exe`,
      args: [
        "/d",
        "/s",
        "/c",
        String.raw`""C:\OpenClaw Prefix\openclaw.cmd" gateway run --port 1234"`,
      ],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  const commandOutputCases: Array<{
    name: string;
    script: string;
    budget: number;
    stdout?: string;
    stderr?: string;
    logs?: string[];
  }> = [
    {
      name: "truncated multibyte tails",
      script: "process.stdout.write('a😀bbbb'); process.stderr.write('a😀cccc');",
      budget: 6,
      stdout: "bbbb",
      stderr: "cccc",
      logs: ["a😀bbbb", "a😀cccc"],
    },
    {
      name: "rolling multibyte tails",
      script:
        "process.stdout.write('a😀'); process.stderr.write('a😀');" +
        "setTimeout(() => { process.stdout.write('bbbb'); process.stderr.write('cccc'); }, 25);",
      budget: 7,
      stdout: "bbbb",
      stderr: "cccc",
    },
    ...(["stdout", "stderr"] as const).map((stream) => ({
      name: `split UTF-8 ${stream} chunks`,
      script:
        `process.${stream}.write('A'); process.${stream}.write(Buffer.from([0xf0, 0x9f]));` +
        `setTimeout(() => { process.${stream}.write(Buffer.from([0x98, 0x80])); process.${stream}.write('Z'); }, 25);`,
      budget: 64,
      [stream]: "A😀Z",
      logs: ["A😀Z"],
    })),
    {
      name: "UTF-8 character larger than the budget",
      script: "process.stdout.write('😀'); process.stderr.write('😀');",
      budget: 1,
      stdout: "",
      stderr: "",
    },
    ...[
      { budget: 1, expected: "" },
      { budget: 3, expected: "�" },
    ].map(({ budget, expected }) => ({
      name: `incomplete UTF-8 within ${budget} bytes`,
      script:
        "process.stdout.write(Buffer.from([0xf0])); process.stderr.write(Buffer.from([0xf0]));",
      budget,
      stdout: expected,
      stderr: expected,
    })),
    {
      name: "full log flushed before resolution",
      script: "process.stdout.write(`flush-start-${'x'.repeat(128 * 1024)}-flush-end`);",
      budget: 64,
      logs: [`flush-start-${"x".repeat(128 * 1024)}-flush-end`],
    },
  ];
  it.each(commandOutputCases)("captures command output: $name", async (testCase) => {
    const result = await captureCommand(testCase.script, testCase.budget);
    for (const stream of ["stdout", "stderr"] as const) {
      if (testCase[stream] !== undefined) {
        expect(result[stream]).toBe(testCase[stream]);
        expect(Buffer.byteLength(result[stream], "utf8")).toBeLessThanOrEqual(testCase.budget);
      }
    }
    for (const marker of testCase.logs ?? []) {
      expect(result.log).toContain(marker);
    }
  });

  it.each([false, true])("resolves npm diagnostic paths: relative=%s", (relative) => {
    const homeDir = relative
      ? join(tempDirs.make("openclaw-cross-os-npm-relative-logs-"), "home")
      : join(tmpdir(), "openclaw-npm-diagnostics-home");
    const logsDir = join(homeDir, relative ? "relative-logs" : "custom-logs");
    if (relative) {
      const cacheLogsDir = join(homeDir, "relative-cache", "_logs");
      mkdirSync(logsDir, { recursive: true });
      mkdirSync(cacheLogsDir, { recursive: true });
      expect(resolveNpmDebugLogDirs(homeDir, { npm_config_cache: "relative-cache" })).toContain(
        cacheLogsDir,
      );
    } else {
      const localAppData = join(homeDir, "AppData", "Local");
      expect(resolveNpmDebugLogDirs(homeDir, { LOCALAPPDATA: localAppData }, "win32")).toContain(
        join(localAppData, "npm-cache", "_logs"),
      );
    }
    expect(
      resolveNpmDebugLogDirs(homeDir, {
        npm_config_logs_dir: relative ? "relative-logs" : logsDir,
      }),
    ).toContain(logsDir);
  });

  it("kills timed-out command process groups", ({ signal }) =>
    fixtureLifetime.run(async () => {
      if (process.platform === "win32") {
        return;
      }

      const dir = tempDirs.make("openclaw-cross-os-run-command-timeout-");
      const childPidPath = join(dir, "child.pid");
      let command: ReturnType<typeof runCommand> = Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
      let releaseAndWait = () => command;
      try {
        const logPath = join(dir, "timeout.log");
        const childScript = "setInterval(() => {}, 1000); process.send('ready');";
        const parentScript = [
          "import { spawn } from 'node:child_process';",
          "import fs from 'node:fs';",
          fixtureReceiptClientSource(receipts.endpoint),
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
          "child.once('message', () => {",
          "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(child.pid));",
          "sendReceipt(process.env.OPENCLAW_TEST_CHILD_PID, 'ready');",
          "child.disconnect();",
          "});",
          "setInterval(() => {}, 1000);",
        ].join("");

        releaseAndWait = startProcessWatchdogFixture(() => {
          command = runCommand(process.execPath, ["--input-type=module", "-e", parentScript], {
            cwd: dir,
            env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
            logPath,
            timeoutMs: 500,
          });
          void command.catch(() => {});
          return command;
        });
        await withinTest(fixtureReadyBeforeSettlement(childPidPath, command), signal);
        const childPid = Number.parseInt(readFileSync(childPidPath, "utf8"), 10);

        await expect(withinTest(releaseAndWait(), signal)).rejects.toThrow(/Command timed out:/u);
        await waitForDead(childPid, signal);
        expect(readFileSync(logPath, "utf8")).toContain("timeout command=");
      } finally {
        await releaseAndWait().catch(() => {});
        const childPid = existsSync(childPidPath)
          ? Number.parseInt(readFileSync(childPidPath, "utf8"), 10)
          : 0;
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
      }
    }));

  it.for([
    { name: "kills descendants that ignore SIGTERM", stubborn: true },
    { name: "exits promptly and flushes logs after graceful termination", stubborn: false },
  ])("forwards command termination: $name", ({ stubborn }, { signal }) =>
    fixtureLifetime.run(async () => {
      if (process.platform === "win32") {
        return;
      }

      const dir = tempDirs.make("openclaw-cross-os-run-command-signal-exit-");
      const childPidPath = join(dir, "child.pid");
      const logPath = join(dir, "signal.log");
      const scriptUrl = resolveRuntimeWorkerUrl(toolingTsEntrypoints.crossOsProcess).href;
      let childPid: number | undefined;
      let runner: ReturnType<typeof spawn> | undefined;
      let completion: ReturnType<typeof observeExit> | undefined;

      try {
        const childScript = stubborn
          ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');"
          : "setInterval(() => {}, 1000); process.send('ready');";
        const parentScript = [
          "import { spawn } from 'node:child_process';",
          "import fs from 'node:fs';",
          fixtureReceiptClientSource(receipts.endpoint),
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
          "child.once('message', () => {",
          "process.stdout.write('signal cleanup log sentinel\\n', () => {",
          "  fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(child.pid));",
          "  sendReceipt(process.env.OPENCLAW_TEST_CHILD_PID, 'ready');",
          "  child.disconnect();",
          "});",
          "});",
          "setInterval(() => {}, 1000);",
        ].join("");
        const runnerScript = [
          `import { runCommand } from ${JSON.stringify(scriptUrl)};`,
          `await runCommand(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(parentScript)}], {`,
          `  cwd: ${JSON.stringify(dir)},`,
          `  env: process.env,`,
          `  logPath: ${JSON.stringify(logPath)},`,
          `  timeoutMs: 60000,`,
          `});`,
        ].join("\n");
        runner = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", runnerScript],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              OPENCLAW_CROSS_OS_PROCESS_TREE_KILL_AFTER_MS: stubborn ? "200" : "3000",
              OPENCLAW_TEST_CHILD_PID: childPidPath,
            },
            stdio: ["ignore", "ignore", "pipe"],
          },
        );
        completion = observeExit(runner);

        await withinTest(fixtureReadyBeforeSettlement(childPidPath, completion), signal);
        childPid = Number.parseInt(readFileSync(childPidPath, "utf8"), 10);
        const signaledAt = Date.now();
        runner.kill("SIGTERM");
        const result = await withinTest(completion, signal);
        const elapsedMs = Date.now() - signaledAt;

        expect(result).toEqual({ signal: null, status: 143 });
        if (!stubborn) {
          expect(elapsedMs).toBeLessThan(2_000);
        }
        expect(readFileSync(logPath, "utf8")).toContain("signal cleanup log sentinel");
        await waitForDead(childPid, signal);
      } finally {
        if (runner?.exitCode === null && runner.signalCode === null) {
          runner.kill("SIGTERM");
        }
        await completion?.catch(() => {});
        childPid ??= existsSync(childPidPath)
          ? Number.parseInt(readFileSync(childPidPath, "utf8"), 10)
          : undefined;
        if (childPid !== undefined && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
      }
    }),
  );

  it("resolves Linux npm package roots when the CLI is a user-local shim", () => {
    const homeDir = tempDirs.make("openclaw-cross-os-linux-home-");
    const packageRoot = join(homeDir, ".npm-global", "lib", "node_modules", "openclaw");
    const distDir = join(packageRoot, "dist");
    const cliDir = join(homeDir, ".local", "bin");
    mkdirSync(distDir, { recursive: true });
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
    writeFileSync(join(distDir, "entry.js"), "#!/usr/bin/env node\n");

    expect(
      resolveInstalledPackageRootFromCliPath(join(cliDir, "openclaw"), "linux", {
        HOME: homeDir,
      }),
    ).toBe(packageRoot);

    rmSync(join(cliDir, "openclaw"), { force: true });
    symlinkSync(join(distDir, "entry.js"), join(cliDir, "openclaw"));

    expect(
      resolveInstalledPackageRootFromCliPath(join(cliDir, "openclaw"), "linux", {
        HOME: homeDir,
      }),
    ).toBe(realpathSync(packageRoot));
  });

  it("detects whether a managed gateway listener is still reachable on loopback", async () => {
    expect(await canConnectToLoopbackPort(0)).toBe(false);
    expect(await canConnectToLoopbackPort(65536)).toBe(false);
    expect(await canConnectToLoopbackPort(1234.5)).toBe(false);

    const server = createNetServer();
    const closed = vi.fn();
    server.on("close", closed);
    await new Promise<void>((resolvePromise) => {
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      expect(await canConnectToLoopbackPort(port)).toBe(true);
    } finally {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      });
    }
    expect(closed).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
    expect(server.address()).toBeNull();

    // Refusal belongs to the observed socket, not a released port another listener can acquire.
    const actualNet = await vi.importActual<typeof import("node:net")>("node:net");
    const refused = new actualNet.Socket();
    const connect = vi.mocked(createNetConnection).mockImplementationOnce(() => {
      queueMicrotask(() => {
        refused.emit(
          "error",
          Object.assign(new Error("fixture connection refused"), {
            code: "ECONNREFUSED",
          }),
        );
      });
      return refused;
    });
    try {
      expect(await canConnectToLoopbackPort(port, 100)).toBe(false);
      expect(refused.destroyed).toBe(true);
    } finally {
      connect.mockRestore();
      refused.destroy();
    }
  });

  it("keeps a release gateway port reserved until the lane is ready to start", async () => {
    const lane = { gatewayPort: 0 } as Parameters<typeof reserveGatewayPortForLane>[0];
    const reservation = await reserveGatewayPortForLane(lane);
    let server: ReturnType<typeof createNetServer>;
    const closed = vi.fn();
    try {
      const created = vi.mocked(createNetServer).mock.results.at(-1);
      if (created?.type !== "return") {
        throw new Error("Gateway port reservation did not create its native listener");
      }
      server = created.value;
      server.on("close", closed);
      expect(lane.gatewayPort).toBe(reservation.port);
      expect(server.address()).toMatchObject({ port: reservation.port });
      expect(await canConnectToLoopbackPort(reservation.port)).toBe(true);
    } finally {
      await reservation.release();
    }
    expect(closed).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
    expect(server.address()).toBeNull();
    await reservation.release();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("bounds Discord API calls with a timeout signal", () => {
    expect(CROSS_OS_DISCORD_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);

    const init = buildDiscordFetchInit("discord-token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(init).toMatchObject({
      method: "POST",
      body: "{}",
    });
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bot discord-token");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("cancels Discord delete response bodies", async () => {
    let canceled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled = true;
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      await deleteDiscordMessage({
        channelId: "channel-123",
        messageId: "message-456",
        token: "discord-token",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(canceled).toBe(true);
  });

  it("verifies main dev updates against the prepared source sha when available", () => {
    expect(resolveDevUpdateVerificationRef("main")).toBe("main");
    expect(
      resolveDevUpdateVerificationRef("main", "08753a1d793c040b101c8a26c43445dbbab14995"),
    ).toBe("08753a1d793c040b101c8a26c43445dbbab14995");
    expect(
      resolveDevUpdateVerificationRef(
        "refs/heads/main",
        "08753a1d793c040b101c8a26c43445dbbab14995",
      ),
    ).toBe("08753a1d793c040b101c8a26c43445dbbab14995");
    expect(resolveDevUpdateVerificationRef("codex/cross-os-release-checks-full-native-e2e")).toBe(
      "codex/cross-os-release-checks-full-native-e2e",
    );
  });

  it("rejects a successful packaged update followed by an old self-swapped process import miss", () => {
    expect(() =>
      verifyPackagedUpgradeUpdateResult({
        exitCode: 1,
        stdout: JSON.stringify({
          status: "ok",
          after: { version: "2026.4.27" },
          steps: [{ name: "global update", exitCode: 0 }],
        }),
        stderr:
          "[openclaw] Failed to start CLI: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/prefix/lib/node_modules/openclaw/dist/memory-state-old.js'",
      }),
    ).toThrow(/Packaged upgrade failed/u);
  });

  it.each([
    {
      name: "shipped Windows native-module backup cleanup failure",
      platform: "win32",
      stdout: JSON.stringify({
        status: "error",
        reason: "global install swap",
        after: { version: "2026.5.2" },
        steps: [
          {
            name: "global install swap",
            exitCode: 1,
            stderrTail:
              "EPERM: operation not permitted, unlink 'C:\\Users\\runner\\prefix\\node_modules\\.openclaw-5748-1777776287462\\node_modules\\@mariozechner\\clipboard-win32-x64-msvc\\clipboard.win32-x64-msvc.node'",
          },
        ],
      }),
      expected: true,
    },
    {
      name: "unrelated Windows failure",
      platform: "win32",
      stdout: JSON.stringify({
        status: "error",
        reason: "global install swap",
        steps: [{ name: "global install swap", exitCode: 1, stderrTail: "ENOENT: missing" }],
      }),
      expected: false,
    },
    {
      name: "non-Windows failure",
      platform: "linux",
      stdout:
        "EPERM: operation not permitted, unlink '/tmp/prefix/node_modules/.openclaw-1-2/native.node'",
      expected: false,
    },
  ] as const)("classifies swap cleanup recovery: $name", ({ platform, stdout, expected }) => {
    expect(
      isRecoverableWindowsPackagedUpgradeSwapCleanupFailure(
        { exitCode: 1, stdout, stderr: "" },
        platform,
      ),
    ).toBe(expected);
  });

  it("recognizes the shipped Windows updater packaged-upgrade timeout", () => {
    const error = new Error(
      "Command timed out: C:\\hostedtoolcache\\windows\\node\\24.15.0\\x64\\node.exe C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\openclaw-upgrade-q9DsA7\\prefix\\node_modules\\openclaw\\openclaw.mjs update --tag http://127.0.0.1:49951/openclaw-2026.5.4-beta.1.tgz --yes --json --no-restart --timeout 1500",
    );

    expect(isRecoverableWindowsPackagedUpgradeTimeoutError(error, "win32")).toBe(true);
    expect(
      isRecoverableWindowsPackagedUpgradeTimeoutError(
        new Error(
          "Command timed out: C:\\prefix\\node_modules\\openclaw\\openclaw.mjs update --yes --json --no-restart --timeout 1200",
        ),
        "win32",
      ),
    ).toBe(true);
    expect(
      isRecoverableWindowsPackagedUpgradeTimeoutError(
        new Error(
          "Command timed out: C:\\prefix\\node_modules\\openclaw\\openclaw.mjs update --tag http://127.0.0.1:49951/openclaw-current.tgz --yes --json --timeout 1500",
        ),
        "win32",
      ),
    ).toBe(true);
    expect(isRecoverableWindowsPackagedUpgradeTimeoutError(error, "linux")).toBe(false);
    expect(
      isRecoverableWindowsPackagedUpgradeTimeoutError(
        new Error("Command timed out: node openclaw.mjs update --tag openclaw@beta"),
        "win32",
      ),
    ).toBe(false);
  });

  it("skips the packaged upgrade status probe after the Windows fallback install", () => {
    expect(
      shouldRunPackagedUpgradeStatusProbe({
        platform: "win32",
        usedWindowsPackagedUpgradeFallback: true,
      }),
    ).toBe(false);
    expect(
      shouldRunPackagedUpgradeStatusProbe({
        platform: "win32",
        usedWindowsPackagedUpgradeFallback: false,
      }),
    ).toBe(true);
    expect(
      shouldRunPackagedUpgradeStatusProbe({
        platform: "linux",
        usedWindowsPackagedUpgradeFallback: true,
      }),
    ).toBe(true);
  });

  it.each([
    { label: "shipped baseline", recoverable: true },
    { label: "non-Windows", platform: "linux" as const },
    { label: "other exit", exitCode: 1 },
    { label: "missing warning", stderr: "Updater failed" },
    { label: "JSON result", stdout: '{"status":"error"}' },
    { label: "first fixed release", baselineVersion: "2026.9.7" },
    { label: "later release", baselineVersion: "2026.9.10" },
    { label: "unknown baseline", baselineVersion: "unknown" },
    { label: "switched install", installedVersion: "2026.9.7" },
  ])("limits unsettled-exit recovery: $label", (testCase) => {
    const baselineVersion = testCase.baselineVersion ?? "2026.9.6";
    expect(
      isRecoverableWindowsPackagedUpgradeUnsettledExit(
        {
          exitCode: testCase.exitCode ?? 13,
          stdout: testCase.stdout ?? "",
          stderr:
            testCase.stderr ??
            "Warning: Detected unsettled top-level await at file:///C:/prefix/node_modules/openclaw/openclaw.mjs:757",
        },
        {
          platform: testCase.platform ?? "win32",
          baselineVersion,
          installedVersion: testCase.installedVersion ?? baselineVersion,
        },
      ),
    ).toBe(testCase.recoverable ?? false);
  });

  it("verifies the Windows packaged-upgrade fallback installed the candidate", () => {
    expect(() =>
      verifyWindowsPackagedUpgradeFallbackInstall({
        installedVersion: "2026.5.4-beta.1",
        candidateVersion: "2026.5.4-beta.1",
      }),
    ).not.toThrow();
    expect(() =>
      verifyWindowsPackagedUpgradeFallbackInstall({
        installedVersion: "2026.5.3",
        candidateVersion: "2026.5.4-beta.1",
      }),
    ).toThrow(/expected 2026\.5\.4-beta\.1/u);
    expect(() =>
      verifyWindowsPackagedUpgradeFallbackInstall({
        installedVersion: "",
        candidateVersion: "2026.5.4-beta.1",
      }),
    ).toThrow(/installed unknown/u);
  });

  it("only treats pinned baseline specs as exact installer version assertions", () => {
    expect(resolveExplicitBaselineVersion("")).toBe("");
    expect(resolveExplicitBaselineVersion("openclaw@latest")).toBe("");
    expect(resolveExplicitBaselineVersion("openclaw@2026.4.10")).toBe("2026.4.10");
    expect(resolveExplicitBaselineVersion("2026.4.10")).toBe("2026.4.10");
  });

  it("reads an installed baseline version without requiring build metadata", () => {
    const prefixDir = tempDirs.make("openclaw-cross-os-installed-version-");
    const packageRoot =
      process.platform === "win32"
        ? join(prefixDir, "node_modules", "openclaw")
        : join(prefixDir, "lib", "node_modules", "openclaw");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "2026.4.10",
      }),
      "utf8",
    );

    expect(readInstalledVersion(prefixDir)).toBe("2026.4.10");
  });

  it("treats missing package scripts as optional in older refs", () => {
    const packageRoot = tempDirs.make("openclaw-cross-os-scripts-");
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        scripts: {
          build: "pnpm build",
        },
      }),
      "utf8",
    );

    expect(packageHasScript(packageRoot, "build")).toBe(true);
    expect(packageHasScript(packageRoot, "ui:build")).toBe(false);
  });

  it.each([
    {
      name: "accepts a git main dev-channel update status payload",
      input: { branch: "main" },
      error: undefined,
    },
    {
      name: "accepts uppercase requested commit shas when update status reports lowercase",
      input: { sha: "08753a1d793c040b101c8a26c43445dbbab14995" },
      ref: "08753A1D793C040B101C8A26C43445DBBAB14995",
      error: undefined,
    },
    {
      name: "rejects update status payloads that are not on dev/main git",
      input: { branch: "release" },
      installKind: "package",
      channel: "stable",
      error: "git install",
    },
  ])("$name", ({ input, ref, installKind, channel, error }) => {
    const payload = JSON.stringify({
      update: { installKind: installKind ?? "git", git: input },
      channel: { value: channel ?? "dev" },
    });
    const verify = () => verifyDevUpdateStatus(payload, ref ? { ref } : undefined);
    if (error) {
      expect(verify).toThrow(error);
    } else {
      expect(verify()).toBeUndefined();
    }
  });
});
