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
import * as checks from "../../scripts/lib/cross-os-release-checks/index.ts";
import type { GatewayHandle } from "../../scripts/lib/cross-os-release-checks/index.ts";
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
import { withinTest, withTestTimeout } from "../helpers/promise.js";
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
function expectContains(text: string | undefined, fragments: string[]) {
  for (const fragment of fragments) {
    expect(text).toContain(fragment);
  }
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

function makeFixture(files: Record<string, string | object>) {
  const root = tempDirs.make("openclaw-cross-os-");
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
  }
  return root;
}

async function withArtifactServer(
  payload: Buffer,
  run: (
    server: Awaited<ReturnType<typeof checks.startStaticFileServer>>,
    logPath: string,
  ) => Promise<void>,
  fileName = "openclaw-2026.4.14.tgz",
) {
  const dir = tempDirs.make("openclaw-cross-os-static-server-");
  const filePath = join(dir, fileName);
  const logPath = join(dir, "server.log");
  writeFileSync(filePath, payload);
  const server = await checks.startStaticFileServer({ filePath, logPath });
  try {
    await run(server, logPath);
  } finally {
    await server.close();
  }
}

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

function processTreeScript(stubborn = false, flushLog = false) {
  const childScript =
    (stubborn ? "process.on('SIGTERM', () => {}); " : "") +
    "setInterval(() => {}, 1000); process.send('ready');";
  const recordReady = [
    "fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(child.pid));",
    "sendReceipt(process.env.OPENCLAW_TEST_CHILD_PID, 'ready');",
    "child.disconnect();",
  ];
  return [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    fixtureReceiptClientSource(receipts.endpoint),
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
    "child.once('message', () => {",
    ...(flushLog
      ? [
          "process.stdout.write('signal cleanup log sentinel\\n', () => {",
          ...recordReady.map((line) => `  ${line}`),
          "});",
        ]
      : recordReady),
    "});",
    "setInterval(() => {}, 1000);",
  ].join("");
}

async function captureCommand(script: string, maxOutputBytes: number) {
  const dir = tempDirs.make("openclaw-cross-os-command-");
  const logPath = join(dir, "command.log");
  const result = await checks.runCommand(process.execPath, ["-e", script], {
    cwd: dir,
    env: process.env,
    logPath,
    maxOutputBytes,
  });
  return { ...result, log: readFileSync(logPath, "utf8") };
}

function createGatewayHandleFixture(
  params: {
    beforeLaunch?: string;
    afterLaunch?: string;
    appendOnWaitForClose?: string;
    exited?: boolean;
  } = {},
) {
  const logPath = join(tempDirs.make("openclaw-gateway-"), "gateway.log");
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
      expect(checks.resolveManagedGatewayInstallerEnv({ env, enabled })).toBe(env);
      return;
    }
    const identityKeys = (
      "OPENCLAW_HOME OPENCLAW_PROFILE OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH " +
      "OPENCLAW_WINDOWS_TASK_NAME OPENCLAW_TASK_SCRIPT_NAME OPENCLAW_TASK_SCRIPT OPENCLAW_SERVICE_KIND " +
      "OpenClaw_Home openclaw_config_path"
    ).split(" ");
    const accountHome = "C:\\Users\\runneradmin";
    const hostEnv = {
      APPDATA: `${accountHome}\\AppData\\Roaming`,
      LOCALAPPDATA: `${accountHome}\\AppData\\Local`,
    };
    const env = checks.resolveManagedGatewayInstallerEnv({
      env: {
        ...Object.fromEntries(identityKeys.map((key) => [key, "isolated-lane"])),
        HOME: "C:\\temp\\lane",
        USERPROFILE: "C:\\temp\\lane",
        APPDATA: "C:\\temp\\lane\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\temp\\lane\\AppData\\Local",
        OPENAI_API_KEY: "secret",
      },
      enabled,
      accountHome,
      hostEnv,
    });
    expect(env).toEqual({
      HOME: accountHome,
      USERPROFILE: accountHome,
      ...hostEnv,
      OPENAI_API_KEY: "secret",
    });
  });

  it("fails closed before borrowing an occupied managed-service account", () => {
    for (const serviceInstalled of [true, false]) {
      expect(() =>
        checks.assertManagedGatewayInstallerHostAvailable({
          accountHome: "C:\\Users\\runneradmin",
          serviceInstalled,
          pathExists: (path) => !serviceInstalled && path.endsWith(".openclaw"),
        }),
      ).toThrow(/pristine host account/);
    }
  });

  it("requires a structured clean-service preflight result", () => {
    const parse = (exitCode: number, stdout = "", stderr = "") =>
      checks.parseManagedGatewayServiceInstalled({ exitCode, stdout, stderr });
    expect(parse(0, JSON.stringify({ service: { loaded: false } }))).toBe(false);
    expect(() => parse(1, "", "status failed")).toThrow(/exit code 1/);
  });

  it("holds an exclusive managed-service host lease until release", () => {
    const accountHome = tempDirs.make("openclaw-managed-host-");
    const lease = checks.acquireManagedGatewayInstallerHostLease(accountHome);

    expect(() => checks.acquireManagedGatewayInstallerHostLease(accountHome)).toThrow(
      /exclusive access/,
    );
    lease.release();
    const replacement = checks.acquireManagedGatewayInstallerHostLease(accountHome);
    replacement.release();
  });

  it("bounds public installer fetches on Windows and POSIX", () => {
    const windowsScript = checks.buildInstallerSmokeScript({
      installerUrl: "https://openclaw.ai/install.ps1",
      installTarget: "2026.7.1",
      platform: "win32",
    });
    const posixScript = checks.buildInstallerSmokeScript({
      installerUrl: "https://openclaw.ai/install.sh",
      installTarget: "2026.7.1",
      platform: "linux",
    });

    expectContains(windowsScript, [
      "curl.exe -fsSL --connect-timeout 10 --max-time 120 -o $installerPath 'https://openclaw.ai/install.ps1'",
      "openclaw-installer-",
      "if ($LASTEXITCODE -ne 0)",
      "[System.IO.File]::ReadAllText($installerPath, [System.Text.Encoding]::UTF8)",
      "Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue",
    ]);
    expect(windowsScript).not.toContain("Invoke-WebRequest");
    expectContains(posixScript, [
      'installer_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-installer-XXXXXX")"',
      "trap 'rm -f \"$installer_path\"' EXIT",
      "curl -fsSL --connect-timeout 10 --max-time 120 -o \"$installer_path\" 'https://openclaw.ai/install.sh'",
      "bash -- \"$installer_path\" --version '2026.7.1' --no-onboard",
    ]);
    expect(posixScript).not.toContain("| bash");
    expect(posixScript).toContain("set -euo pipefail");
  });

  it("drops split surrogate pairs when truncating response bodies", async () => {
    await expect(checks.readBoundedCrossOsResponseText(new Response("abc😀tail"), 4)).resolves.toBe(
      "abc\n[truncated]",
    );
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

    const summary = checks.trimForSummary(formatError(error));
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

    const text = checks.readBoundedCrossOsResponseText(response, 1024, {
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

    expect(checks.dashboardHtmlMarkerStatus(html)).toEqual({ app: true, ready: true, title: true });
    expect(checks.resolveDashboardAssetUrls("http://127.0.0.1:18789/", html)).toEqual([
      "http://127.0.0.1:18789/assets/index.css",
      "http://127.0.0.1:18789/assets/index.js",
    ]);
  });

  it("fails dashboard readiness when assets are missing or unreachable", async () => {
    await expect(checks.verifyDashboardAssetUrls([])).resolves.toEqual({
      failures: ["no dashboard asset URLs found"],
      ok: false,
    });

    const result = await checks.verifyDashboardAssetUrls(
      ["http://127.0.0.1:18789/assets/index.css", "http://127.0.0.1:18789/assets/index.js"],
      async (url) =>
        new Response("", {
          status: (url instanceof Request ? url.url : url.toString()).endsWith(".js") ? 404 : 200,
        }),
    );

    expect(result).toMatchObject({
      ok: false,
      failures: ["http://127.0.0.1:18789/assets/index.js status=404"],
    });
  });

  it("keeps gateway RPC status probes patient enough for live release startup", () => {
    expect(checks.CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(checks.CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS).toBeGreaterThan(
      checks.CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS,
    );
    expect(checks.CROSS_OS_GATEWAY_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
    expect(checks.CROSS_OS_WINDOWS_GATEWAY_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000);
    expect(checks.managedGatewayRestartCommandTimeoutMs("win32")).toBeGreaterThan(
      checks.CROSS_OS_WINDOWS_GATEWAY_READY_TIMEOUT_MS,
    );
    expect(checks.managedGatewayRestartCommandTimeoutMs("linux")).toBeGreaterThan(
      checks.CROSS_OS_GATEWAY_READY_TIMEOUT_MS,
    );
  });

  it("keeps gateway status RPC probing when help probing is unavailable", () => {
    expect(checks.buildGatewayStatusArgsFromHelpText("--require-rpc")).toEqual([
      ..."gateway status --require-rpc --timeout".split(" "),
      String(checks.CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS),
    ]);
    expect(checks.buildGatewayStatusArgsFromHelpText("Usage: openclaw gateway status")).toEqual([
      "gateway",
      "status",
    ]);
    expect(
      checks.buildGatewayStatusArgsFromHelpText("--require-rpc", { requireRpc: false }),
    ).toEqual(["gateway", "status"]);
  });

  it.each(["recovered", "stale", "live", "repeated"] as const)(
    "bounds startup-migration restarts: %s",
    async (scenario) => {
      const refusal =
        "OpenClaw plugin migration inputs changed during startup convergence; refusing to report the gateway ready.\n";
      const first = createGatewayHandleFixture({
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
        afterLaunch: refusal,
        exited: scenario === "repeated",
      });
      const holder: { current: GatewayHandle | null } = { current: first.handle };
      const firstError = new Error("first gateway failed readiness");
      const secondError = new Error("second gateway exited");
      const restartGateway = vi.fn(async () => second.handle);
      const ready = checks.waitForGatewayWithStartupRecovery({
        gatewayPort: 18_789,
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
    const previous = createGatewayHandleFixture();
    const started = createGatewayHandleFixture();
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

    await checks.restartManualGatewayForDiscordSmoke({
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
      expect(checks.resolvePackagedUpgradeTimeouts(durationMs, "win32")).toEqual({
        stepTimeoutSeconds,
        wrapperTimeoutMs,
      });
      expect(checks.resolvePackagedUpgradeTimeouts(durationMs, "linux")).toEqual({
        stepTimeoutSeconds: 1200,
        wrapperTimeoutMs: 1_200_000,
      });
    },
  );

  it("rejects malformed cross-OS positive integer environment values", () => {
    const key = "OPENCLAW_CROSS_OS_COMMAND_HEARTBEAT_SECONDS";
    const parse = (env: NodeJS.ProcessEnv) => checks.parsePositiveIntegerEnv(key, 60, env);
    expect(parse({})).toBe(60);
    expect(parse({ [key]: "25" })).toBe(25);
    for (const raw of ["1e3", "25ms", "1.5", "0", "-1", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() => parse({ [key]: raw })).toThrow(`${key} must be a positive integer`);
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
      expect(checks.parsePackagedUpgradeUpdateTimings(input)).toEqual(expected);
    }
  });

  it("renders runner, runtime, and sanitized updater timing evidence", () => {
    const dir = tempDirs.make("openclaw-cross-os-summary-");
    checks.writeSummary(dir, {
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

  it("ignores stale OK markers outside the recent tail", () => {
    const logPath = join(tempDirs.make("openclaw-cross-os-agent-output-"), "agent.log");
    writeFileSync(
      logPath,
      [
        JSON.stringify({ payloads: [{ type: "text", text: "OK" }] }),
        "x".repeat(2_200_000),
        JSON.stringify({ payloads: [{ type: "text", text: "still working" }] }),
      ].join("\n"),
    );
    expect(checks.agentOutputHasExpectedOkMarker("", { logPath })).toBe(false);
  });

  it("allows cross-OS provider smoke models to use faster CI overrides", () => {
    for (const [key, model] of [
      ["OPENCLAW_CROSS_OS_OPENAI_MODEL", "openai/gpt-5.4-mini"],
      ["OPENCLAW_CROSS_OS_MODEL", "openai/gpt-5.4-nano"],
    ]) {
      expect(checks.resolveProviderConfig("openai", { [key]: model })?.model).toBe(model);
    }
    expect(checks.resolveProviderConfig("openai", {})).toMatchObject({
      model: "openai/gpt-5.6-luna",
      requiredCompanionPackages: ["@openclaw/codex"],
    });
    expect(checks.resolveProviderConfig("anthropic", {})?.requiredCompanionPackages).toEqual([]);
    expect(checks.resolveProviderConfig("minimax", {})?.requiredCompanionPackages).toEqual([]);
  });

  it("can stage packaged-upgrade baselines without npm lifecycle scripts", () => {
    expect(checks.buildNpmGlobalInstallArgs("openclaw@2026.5.2", { ignoreScripts: true })).toEqual(
      "install -g openclaw@2026.5.2 --omit=dev --no-fund --no-audit --ignore-scripts --loglevel=notice".split(
        " ",
      ),
    );
  });

  it("rejects unsafe pnpm pack destinations", () => {
    const packDir = resolvePath("/tmp/openclaw-pack");
    for (const filename of [
      "../openclaw.tgz",
      "nested/openclaw.tgz",
      "nested\\openclaw.tgz",
      resolvePath(dirname(packDir), "openclaw.tgz"),
      resolvePath(packDir, "nested", "openclaw.tgz"),
      "openclaw\u0000.tgz",
      "openclaw.tar.gz",
    ]) {
      expect(() => checks.resolvePackDestinationTarball(filename, packDir, "pnpm pack")).toThrow(
        "pnpm pack did not report a safe .tgz filename.",
      );
    }
  });

  it("prepares source-owned package inventory for isolated candidates", async () => {
    const sourceDir = makeFixture({
      "package.json": {
        name: "openclaw",
        version: "2026.9.1",
        bundleDependencies: ["fixture-runtime"],
      },
      "CHANGELOG.md":
        "# Changelog\n\n## 2026.9.1\n\n- Preserve source-owned inventory during candidate packaging.\n",
      "pnpm-workspace.yaml": "nodeLinker: isolated\n",
      "scripts/package-openclaw-for-docker.mjs": "export {};\n",
    });
    const outputDir = join(sourceDir, "out");
    const logsDir = join(sourceDir, "logs");
    const helperPath = join(sourceDir, "scripts", "package-openclaw-for-docker.mjs");
    const inventoryPath = join(sourceDir, "dist", "postinstall-inventory.json");
    const candidateTgz = join(outputDir, "package", "openclaw-2026.9.1.tgz");
    const sourceSha = "a".repeat(40);
    const commands = vi
      .spyOn(candidateProcess, "runCommand")
      .mockImplementation(async (_, args) => {
        let stdout = "";
        if (args[0] === "rev-parse") {
          stdout = sourceSha;
        } else if (args[0] === helperPath) {
          writeJson(inventoryPath, ["dist/from-source-helper.js"]);
          writeFileSync(candidateTgz, "fixture tarball");
          stdout = `${candidateTgz}\n`;
        } else if (args[0] === "pack") {
          throw new Error('bundleDependencies does not work with "nodeLinker: isolated"');
        }
        return { exitCode: 0, stdout, stderr: "" };
      });
    try {
      const candidate = await checks.prepareCandidate({ sourceDir, outputDir, logsDir });

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
  ])("routes packaged upgrades from the $label channel", (testCase) => {
    const candidateUrl = "http://127.0.0.1:49152/openclaw-current.tgz";
    const updateCommand = checks.buildPackagedUpgradeUpdateCommand({
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

  it.each([
    ["--force  Skip confirmation", ["gateway", "stop", "--force"]],
    ["--disable  Disable the service", ["gateway", "stop"]],
  ] as const)("uses forced shutdown only when supported: %s", (help, expected) => {
    expect(checks.buildGatewayStopArgsFromHelpText(help)).toEqual(expected);
  });

  it("treats explicit empty-string args as values instead of boolean flags", () => {
    expect(checks.parseArgs(["--ubuntu-runner", "", "--mode", "both"])).toEqual({
      "ubuntu-runner": "",
      mode: "both",
    });
  });

  it("normalizes full Git refs before suite and update decisions", () => {
    const packaged = ["packaged-fresh", "installer-fresh", "packaged-upgrade"];
    expect(checks.normalizeRequestedRef(" refs/heads/main ")).toBe("main");
    expect(checks.normalizeRequestedRef("refs/tags/v2026.4.14")).toBe("v2026.4.14");
    expect(checks.isImmutableReleaseRef("refs/tags/test-tag")).toBe(true);
    for (const ref of ["refs/tags/v2026.4.14", "refs/tags/test-tag"]) {
      expect(checks.resolveRequestedSuites("both", ref)).toEqual(packaged);
    }
    expect(checks.shouldRunMainChannelDevUpdate("refs/heads/main")).toBe(true);
    expect(checks.shouldRunMainChannelDevUpdate("refs/tags/main")).toBe(false);
    expect(checks.resolveRequestedSuites("both", "main")).toEqual([...packaged, "dev-update"]);
  });

  it("preflights standalone source candidates before cross-OS dependency installation", async () => {
    const sourceDir = makeFixture({
      "package.json": {
        name: "openclaw",
        version: "2026.8.1",
        dependencies: { "@openclaw/ai": "workspace:*", "partial-json": "0.1.8" },
      },
      "packages/ai/package.json": {
        name: "@openclaw/ai",
        version: "2026.8.1",
        dependencies: { "partial-json": "0.1.7" },
      },
      "CHANGELOG.md":
        "# Changelog\n\n## Unreleased\n\n- Validate source metadata before installing dependencies.\n",
    });
    const logsDir = join(sourceDir, "logs");
    const outputDir = join(sourceDir, "output");
    mkdirSync(logsDir, { recursive: true });

    await expect(checks.prepareCandidate({ logsDir, outputDir, sourceDir })).rejects.toThrow(
      "package.json must declare partial-json@0.1.7",
    );
    expect(existsSync(join(logsDir, "pnpm-install.log"))).toBe(false);
  });

  it("rejects unsupported cross-OS suite filter tokens", () => {
    expect(() => checks.parseCrossOsSuiteFilter("windows/nope")).toThrow(
      /Unsupported cross_os_suite_filter/u,
    );
  });

  it("prefers the freshly installed Windows CLI under npm's prefix before PATH lookup", () => {
    const script = checks.buildWindowsFreshShellVersionCheckScript({
      expectedNeedle: "2026.4.14",
    });
    expect(script).toContain("foreach ($candidate in @($env:Path, $userPath, $machinePath))");
    expect(script).toContain("Get-Command npm.cmd -ErrorAction SilentlyContinue");
    expect(script).toContain('$env:Path = "$npmPrefix;$env:Path"');
    expect(script).toContain("(Join-Path $npmPrefix 'openclaw.cmd')");
    expect(script).toContain("$cmd = Get-Command openclaw -ErrorAction Stop");
  });

  it("keeps Windows dev-update toolchain checks compatible with setup-node PATH shims", () => {
    const script = checks.buildWindowsDevUpdateToolchainCheckScript();
    expect(script).toContain("foreach ($candidate in @($env:Path, $userPath, $machinePath))");
    expect(script).toContain("$pnpmPath = Resolve-CommandPath 'pnpm'");
    expect(script).toContain("$corepackPath = Resolve-CommandPath 'corepack'");
    expect(script).toContain("$npmPath = Resolve-CommandPath 'npm'");
  });

  it("uses legacy runner overrides when primary values are blank", () => {
    expect(
      checks.readRunnerOverrideEnv({
        VAR_UBUNTU_RUNNER: "",
        VAR_WINDOWS_RUNNER: " ",
        VAR_MACOS_RUNNER: "",
        OPENCLAW_RELEASE_CHECKS_UBUNTU_RUNNER: "legacy-linux",
        OPENCLAW_RELEASE_CHECKS_WINDOWS_RUNNER: "legacy-windows",
        OPENCLAW_RELEASE_CHECKS_MACOS_RUNNER: "legacy-macos",
      }),
    ).toEqual({
      varUbuntuRunner: "legacy-linux",
      varWindowsRunner: "legacy-windows",
      varMacosRunner: "legacy-macos",
    });
  });

  it("serves installer scripts as UTF-8 text and package payloads as binary", () => {
    expect(checks.resolveStaticFileContentType("scripts/install.sh")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(checks.resolveStaticFileContentType("scripts/install.ps1")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(checks.resolveStaticFileContentType("openclaw-2026.4.14.tgz")).toBe(
      "application/octet-stream",
    );
  });

  it("streams release artifacts with URL-encoded filenames", async () => {
    const fileName = "openclaw release-🦞#.tgz";
    const requestPath = "/openclaw%20release-%F0%9F%A6%9E%23.tgz";
    const payload = Buffer.from(`artifact-head\n${"x".repeat(1024 * 1024)}\nartifact-tail`);
    await withArtifactServer(
      payload,
      async (server, logPath) => {
        const response = await fetch(server.url);
        const body = Buffer.from(await response.arrayBuffer());

        expect(response.status).toBe(200);
        expect(response.headers.get("content-length")).toBe(String(payload.length));
        expect(response.headers.get("content-type")).toBe("application/octet-stream");
        expect(body.equals(payload)).toBe(true);
        await server.close();
        expect(readFileSync(logPath, "utf8")).toContain(`GET ${requestPath}`);
      },
      fileName,
    );
  });

  it("closes static release artifact sockets left by aborted clients", async () => {
    await withArtifactServer(Buffer.alloc(1024 * 1024, "x"), async (server) => {
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
      await withTestTimeout(server.close(), 1_000, "close timed out");
      await withTestTimeout(socketClosePromise, 1_000, "socket close timed out");
    });
  });

  it("flushes static release artifact logs before close resolves", async () => {
    await withArtifactServer(Buffer.alloc(128, "x"), async (server, logPath) => {
      const marker = `flush-${"x".repeat(512)}-done`;

      for (let index = 0; index < 8; index += 1) {
        const response = await fetch(`${server.url}?${marker}-${index}`);
        await response.text();
      }
      await server.close();
      expect(readFileSync(logPath, "utf8")).toContain(`${marker}-7`);
    });
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
      decide: checks.resolvePublishedInstallerUrl,
      inputs: ["darwin", "linux", "win32"] as const,
      expected: [
        "https://openclaw.ai/install.sh",
        "https://openclaw.ai/install.sh",
        "https://openclaw.ai/install.ps1",
      ],
    },
    {
      name: "uses managed gateway services only on native Windows runners",
      decide: checks.shouldUseManagedGatewayService,
      inputs: ["win32", "darwin", "linux"] as const,
      expected: [true, false, false],
    },
  ])("$name", ({ decide, inputs, expected }) => {
    expect(inputs.map((platform) => decide(platform))).toEqual(expected);
  });

  it("skips workspace bootstrap during release onboarding", () => {
    expect(
      checks.buildReleaseOnboardArgs({
        authChoice: "openai-api-key",
        gatewayPort: 34111,
        skipHealth: true,
      }),
    ).toEqual(
      (
        "onboard --non-interactive --mode local --auth-choice openai-api-key --secret-input-mode ref " +
        "--gateway-port 34111 --gateway-bind loopback --skip-skills --skip-bootstrap --accept-risk --json --skip-health"
      ).split(" "),
    );
  });

  it("runs the installed browser override import smoke only on native Windows", () => {
    expect(checks.shouldRunWindowsInstalledBrowserOverrideImportSmoke("win32")).toBe(true);
    expect(checks.shouldRunWindowsInstalledBrowserOverrideImportSmoke("darwin")).toBe(false);
    expect(checks.shouldRunWindowsInstalledBrowserOverrideImportSmoke("linux")).toBe(false);

    const script = checks.buildInstalledBrowserOverrideImportProbeScript();
    expect(script).toContain('from "openclaw/plugin-sdk/plugin-runtime"');
    expect(script).toContain('overrideEnvVar: "OPENCLAW_BROWSER_CONTROL_MODULE"');
    expect(script).toContain("startBrowserControlService");
    expect(script).toContain("stopBrowserControlService");
    expect(script).toContain("Browser control override start sentinel was not written.");

    const installedScript = checks.buildInstalledBrowserOverrideImportProbeScript(
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
    vi.stubEnv("ComSpec", String.raw`C:\Users\test\bin\cmd.exe`);
    vi.stubEnv("SystemRoot", String.raw`D:\Windows`);
    try {
      expect(
        checks.resolveCommandSpawnInvocation(
          String.raw`C:\Program Files\nodejs\npm.cmd`,
          ["--version"],
          {
            platform: "win32",
          },
        ).command,
      ).toBe(String.raw`D:\Windows\System32\cmd.exe`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("wraps installed Windows CLI cmd fallbacks without Node shell argv", () => {
    expect(
      checks.resolveInstalledCliInvocation(
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
      expect(
        checks.resolveNpmDebugLogDirs(homeDir, { npm_config_cache: "relative-cache" }),
      ).toContain(cacheLogsDir);
    } else {
      const localAppData = join(homeDir, "AppData", "Local");
      expect(
        checks.resolveNpmDebugLogDirs(homeDir, { LOCALAPPDATA: localAppData }, "win32"),
      ).toContain(join(localAppData, "npm-cache", "_logs"));
    }
    expect(
      checks.resolveNpmDebugLogDirs(homeDir, {
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
      let command: ReturnType<typeof checks.runCommand> = Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
      });
      let releaseAndWait = () => command;
      try {
        const logPath = join(dir, "timeout.log");
        const parentScript = processTreeScript();

        releaseAndWait = startProcessWatchdogFixture(() => {
          command = checks.runCommand(
            process.execPath,
            ["--input-type=module", "-e", parentScript],
            {
              cwd: dir,
              env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
              logPath,
              timeoutMs: 500,
            },
          );
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
        const parentScript = processTreeScript(stubborn, true);
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
    writeJson(join(packageRoot, "package.json"), { name: "openclaw" });
    writeFileSync(join(distDir, "entry.js"), "#!/usr/bin/env node\n");

    expect(
      checks.resolveInstalledPackageRootFromCliPath(join(cliDir, "openclaw"), "linux", {
        HOME: homeDir,
      }),
    ).toBe(packageRoot);

    rmSync(join(cliDir, "openclaw"), { force: true });
    symlinkSync(join(distDir, "entry.js"), join(cliDir, "openclaw"));

    expect(
      checks.resolveInstalledPackageRootFromCliPath(join(cliDir, "openclaw"), "linux", {
        HOME: homeDir,
      }),
    ).toBe(realpathSync(packageRoot));
  });

  it("detects whether a managed gateway listener is still reachable on loopback", async () => {
    expect(await checks.canConnectToLoopbackPort(0)).toBe(false);
    expect(await checks.canConnectToLoopbackPort(65536)).toBe(false);
    expect(await checks.canConnectToLoopbackPort(1234.5)).toBe(false);

    const server = createNetServer();
    const closed = vi.fn();
    server.on("close", closed);
    await new Promise<void>((resolvePromise) => {
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      expect(await checks.canConnectToLoopbackPort(port)).toBe(true);
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
      expect(await checks.canConnectToLoopbackPort(port, 100)).toBe(false);
      expect(refused.destroyed).toBe(true);
    } finally {
      connect.mockRestore();
      refused.destroy();
    }
  });

  it("keeps a release gateway port reserved until the lane is ready to start", async () => {
    const lane = { gatewayPort: 0 } as Parameters<typeof checks.reserveGatewayPortForLane>[0];
    const reservation = await checks.reserveGatewayPortForLane(lane);
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
      expect(await checks.canConnectToLoopbackPort(reservation.port)).toBe(true);
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
    expect(checks.CROSS_OS_DISCORD_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);

    const init = checks.buildDiscordFetchInit("discord-token", {
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
      await checks.deleteDiscordMessage({
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
    const sha = "08753a1d793c040b101c8a26c43445dbbab14995";
    expect(checks.resolveDevUpdateVerificationRef("main")).toBe("main");
    for (const ref of ["main", "refs/heads/main"]) {
      expect(checks.resolveDevUpdateVerificationRef(ref, sha)).toBe(sha);
    }
    const branch = "codex/cross-os-release-checks-full-native-e2e";
    expect(checks.resolveDevUpdateVerificationRef(branch)).toBe(branch);
  });

  it("rejects a successful packaged update followed by an old self-swapped process import miss", () => {
    expect(() =>
      checks.verifyPackagedUpgradeUpdateResult({
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
    [
      "win32",
      "global install swap EPERM unlink 'C:\\prefix\\.openclaw-5748-1777776287462\\native.node'",
      true,
    ],
    [
      "linux",
      "EPERM: operation not permitted, unlink '/tmp/prefix/node_modules/.openclaw-1-2/native.node'",
      false,
    ],
  ] as const)("classifies swap cleanup recovery on %s", (platform, stdout, expected) => {
    expect(
      checks.isRecoverableWindowsPackagedUpgradeSwapCleanupFailure(
        { exitCode: 1, stdout, stderr: "" },
        platform,
      ),
    ).toBe(expected);
  });

  it("recognizes the shipped Windows updater packaged-upgrade timeout", () => {
    const classify = (message: string, platform: NodeJS.Platform = "win32") =>
      checks.isRecoverableWindowsPackagedUpgradeTimeoutError(new Error(message), platform);
    const error = new Error(
      "Command timed out: C:\\hostedtoolcache\\windows\\node\\24.15.0\\x64\\node.exe C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\openclaw-upgrade-q9DsA7\\prefix\\node_modules\\openclaw\\openclaw.mjs update --tag http://127.0.0.1:49951/openclaw-2026.5.4-beta.1.tgz --yes --json --no-restart --timeout 1500",
    );

    expect(checks.isRecoverableWindowsPackagedUpgradeTimeoutError(error, "win32")).toBe(true);
    for (const command of [
      "Command timed out: C:\\prefix\\node_modules\\openclaw\\openclaw.mjs update --yes --json --no-restart --timeout 1200",
      "Command timed out: C:\\prefix\\node_modules\\openclaw\\openclaw.mjs update --tag http://127.0.0.1:49951/openclaw-current.tgz --yes --json --timeout 1500",
    ]) {
      expect(classify(command)).toBe(true);
    }
    expect(checks.isRecoverableWindowsPackagedUpgradeTimeoutError(error, "linux")).toBe(false);
    expect(classify("Command timed out: node openclaw.mjs update --tag openclaw@beta")).toBe(false);
  });

  it("skips the packaged upgrade status probe after the Windows fallback install", () => {
    const probe = (platform: NodeJS.Platform, usedWindowsPackagedUpgradeFallback: boolean) =>
      checks.shouldRunPackagedUpgradeStatusProbe({ platform, usedWindowsPackagedUpgradeFallback });
    expect(probe("win32", true)).toBe(false);
    expect(probe("win32", false)).toBe(true);
    expect(probe("linux", true)).toBe(true);
  });

  it.each([
    { label: "shipped baseline", recoverable: true },
    { label: "first fixed release", baselineVersion: "2026.9.7" },
    { label: "unknown baseline", baselineVersion: "unknown" },
    { label: "switched install", installedVersion: "2026.9.7" },
  ])("limits unsettled-exit recovery: $label", (testCase) => {
    const baselineVersion = testCase.baselineVersion ?? "2026.9.6";
    expect(
      isRecoverableWindowsPackagedUpgradeUnsettledExit(
        {
          exitCode: 13,
          stdout: "",
          stderr:
            "Warning: Detected unsettled top-level await at file:///C:/prefix/node_modules/openclaw/openclaw.mjs:757",
        },
        {
          platform: "win32",
          baselineVersion,
          installedVersion: testCase.installedVersion ?? baselineVersion,
        },
      ),
    ).toBe(testCase.recoverable ?? false);
  });

  it("verifies the Windows packaged-upgrade fallback installed the candidate", () => {
    const verify = (installedVersion: string) => () =>
      checks.verifyWindowsPackagedUpgradeFallbackInstall({
        installedVersion,
        candidateVersion: "2026.5.4-beta.1",
      });
    expect(verify("2026.5.4-beta.1")).not.toThrow();
    expect(verify("2026.5.3")).toThrow(/expected 2026\.5\.4-beta\.1/u);
    expect(verify("")).toThrow(/installed unknown/u);
  });

  it("only treats pinned baseline specs as exact installer version assertions", () => {
    expect(checks.resolveExplicitBaselineVersion("")).toBe("");
    expect(checks.resolveExplicitBaselineVersion("openclaw@latest")).toBe("");
    expect(checks.resolveExplicitBaselineVersion("openclaw@2026.4.10")).toBe("2026.4.10");
    expect(checks.resolveExplicitBaselineVersion("2026.4.10")).toBe("2026.4.10");
  });

  it("reads an installed baseline version without requiring build metadata", () => {
    const prefixDir = tempDirs.make("openclaw-cross-os-installed-version-");
    const packageRoot =
      process.platform === "win32"
        ? join(prefixDir, "node_modules", "openclaw")
        : join(prefixDir, "lib", "node_modules", "openclaw");
    mkdirSync(packageRoot, { recursive: true });
    writeJson(join(packageRoot, "package.json"), { name: "openclaw", version: "2026.4.10" });

    expect(checks.readInstalledVersion(prefixDir)).toBe("2026.4.10");
  });

  it("treats missing package scripts as optional in older refs", () => {
    const packageRoot = tempDirs.make("openclaw-cross-os-scripts-");
    writeJson(join(packageRoot, "package.json"), {
      name: "openclaw",
      scripts: { build: "pnpm build" },
    });

    expect(checks.packageHasScript(packageRoot, "build")).toBe(true);
    expect(checks.packageHasScript(packageRoot, "ui:build")).toBe(false);
  });

  it.each([
    ["main git", { branch: "main" }, undefined, "git", "dev", undefined],
    [
      "uppercase SHA",
      { sha: "08753a1d793c040b101c8a26c43445dbbab14995" },
      "08753A1D793C040B101C8A26C43445DBBAB14995",
      "git",
      "dev",
      undefined,
    ],
    ["non-dev install", { branch: "release" }, undefined, "package", "stable", "git install"],
  ] as const)(
    "verifies dev update status: %s",
    (_name, input, ref, installKind, channel, error) => {
      const payload = JSON.stringify({
        update: { installKind, git: input },
        channel: { value: channel },
      });
      const verify = () => checks.verifyDevUpdateStatus(payload, ref ? { ref } : undefined);
      if (error) {
        expect(verify).toThrow(error);
      } else {
        expect(verify()).toBeUndefined();
      }
    },
  );
});
