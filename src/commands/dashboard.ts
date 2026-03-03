import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { copyToClipboard } from "../infra/clipboard.js";
import { resolveControlUiRepoRoot } from "../infra/control-ui-assets.js";
import { tryListenOnPort } from "../infra/ports-probe.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import {
  detectBrowserOpenSupport,
  formatControlUiSshHint,
  openUrl,
  probeGatewayReachable,
  resolveControlUiLinks,
  waitForGatewayReachable,
} from "./onboard-helpers.js";

type DashboardOptions = {
  noOpen?: boolean;
  mode?: string;
  uiPort?: string;
};

type DashboardMode = "default" | "dev";
const FALLBACK_DASHBOARD_DEV_PORT = 5173;

function normalizeDashboardMode(value: string | undefined): DashboardMode {
  const raw = value?.trim().toLowerCase();
  if (!raw) {
    return "default";
  }
  if (raw === "dev") {
    return "dev";
  }
  throw new Error(`Unknown dashboard mode: ${value}. Supported mode: dev`);
}

function resolveDashboardDevRepoRoot(): string | null {
  const fromArgv = resolveControlUiRepoRoot(process.argv[1]);
  if (fromArgv) {
    return fromArgv;
  }
  const cwd = process.cwd();
  if (
    fs.existsSync(path.join(cwd, "ui", "vite.config.ts")) &&
    fs.existsSync(path.join(cwd, "scripts", "ui.js"))
  ) {
    return cwd;
  }
  return null;
}

function resolveDashboardDevPort(options: DashboardOptions, gatewayPort: number): number {
  const raw = (options.uiPort ?? process.env.OPENCLAW_CONTROL_UI_DEV_PORT ?? "").trim();
  if (!raw) {
    const nearGateway = gatewayPort + 1;
    return nearGateway <= 65_535 ? nearGateway : FALLBACK_DASHBOARD_DEV_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid dashboard dev port: ${raw}. Expected an integer from 1 to 65535.`);
  }
  return parsed;
}

function buildDevDashboardUrl(params: { wsUrl: string; token?: string; port: number }) {
  const url = new URL(`http://127.0.0.1:${params.port}/`);
  url.searchParams.set("gatewayUrl", params.wsUrl);
  if (params.token) {
    url.searchParams.set("token", params.token);
  }
  return url.toString();
}

function isLoopbackGatewayHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "[::1]" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

function resolveWsPort(url: URL): number {
  if (url.port) {
    return Number.parseInt(url.port, 10);
  }
  return url.protocol === "wss:" ? 443 : 80;
}

function resolveCliEntryPath(repoRoot: string): string {
  const argv1 = process.argv[1];
  if (argv1 && fs.existsSync(argv1)) {
    return argv1;
  }
  const fallback = path.join(repoRoot, "openclaw.mjs");
  if (fs.existsSync(fallback)) {
    return fallback;
  }
  throw new Error("Could not resolve OpenClaw CLI entrypoint for auto-starting gateway.");
}

function stopChildProcess(child: ReturnType<typeof spawn> | null) {
  if (!child || child.exitCode !== null) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {}
}

type DashboardDevGatewayBootstrapResult = {
  process: ReturnType<typeof spawn> | null;
  mode: "reused" | "auto-started";
};

async function ensureGatewayReachableForDashboardDev(params: {
  repoRoot: string;
  runtime: RuntimeEnv;
  wsUrl: string;
  token?: string;
  password?: string;
}): Promise<DashboardDevGatewayBootstrapResult> {
  const initialProbe = await probeGatewayReachable({
    url: params.wsUrl,
    token: params.token,
    password: params.password,
    timeoutMs: 1200,
  });
  if (initialProbe.ok) {
    return { process: null, mode: "reused" };
  }

  const parsed = (() => {
    try {
      return new URL(params.wsUrl);
    } catch {
      return null;
    }
  })();
  if (!parsed) {
    throw new Error(`Invalid gateway URL for dashboard dev: ${params.wsUrl}`);
  }

  const host = parsed.hostname;
  const port = resolveWsPort(parsed);
  if (!isLoopbackGatewayHostname(host)) {
    throw new Error(
      `Gateway not reachable at ${params.wsUrl}: ${initialProbe.detail ?? "unknown error"}. Start your remote gateway first, then rerun this command.`,
    );
  }

  let portFree = false;
  try {
    await tryListenOnPort({ port });
    portFree = true;
  } catch {
    portFree = false;
  }

  if (!portFree) {
    throw new Error(
      `Gateway health probe failed at ${params.wsUrl}: ${initialProbe.detail ?? "unknown error"}. Port ${port} is already in use; verify auth/token and that the process on this port is OpenClaw.`,
    );
  }

  const cliEntry = resolveCliEntryPath(params.repoRoot);
  params.runtime.log(
    `Gateway not reachable at ${params.wsUrl}. Starting local gateway on port ${port}...`,
  );
  const gatewayChild = spawn(
    process.execPath,
    [cliEntry, "gateway", "run", "--bind", "loopback", "--port", String(port), "--force"],
    {
      cwd: params.repoRoot,
      env: process.env,
      stdio: "inherit",
    },
  );

  const ready = await waitForGatewayReachable({
    url: params.wsUrl,
    token: params.token,
    password: params.password,
    deadlineMs: 18_000,
    pollMs: 400,
    probeTimeoutMs: 1200,
  });
  if (!ready.ok) {
    stopChildProcess(gatewayChild);
    throw new Error(
      `Started a local gateway process, but it did not become reachable at ${params.wsUrl}: ${ready.detail ?? "unknown error"}`,
    );
  }

  params.runtime.log(`Gateway is ready at ${params.wsUrl}.`);
  return { process: gatewayChild, mode: "auto-started" };
}

async function runUiDevServer(params: { repoRoot: string; port: number }): Promise<void> {
  const uiScriptPath = path.join(params.repoRoot, "scripts", "ui.js");
  if (!fs.existsSync(uiScriptPath)) {
    throw new Error(`UI dev runner not found: ${uiScriptPath}`);
  }

  const child = spawn(process.execPath, [uiScriptPath, "dev", "--port", String(params.port)], {
    cwd: params.repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", (error) => reject(error));
    child.once("exit", (exitCode) => resolve(exitCode ?? 0));
  });
  if (code !== 0) {
    throw new Error(`Control UI dev server exited with code ${code}`);
  }
}

export async function dashboardCommand(
  runtime: RuntimeEnv = defaultRuntime,
  options: DashboardOptions = {},
) {
  const mode = normalizeDashboardMode(options.mode);
  const snapshot = await readConfigFileSnapshot();
  const cfg = snapshot.valid ? snapshot.config : {};
  const port = resolveGatewayPort(cfg);
  const bind = cfg.gateway?.bind ?? "loopback";
  const basePath = cfg.gateway?.controlUi?.basePath;
  const customBindHost = cfg.gateway?.customBindHost;
  const token = cfg.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
  const password = cfg.gateway?.auth?.password ?? process.env.OPENCLAW_GATEWAY_PASSWORD ?? "";

  // LAN URLs fail secure-context checks in browsers.
  // Coerce only lan->loopback and preserve other bind modes.
  const links = resolveControlUiLinks({
    port,
    bind: bind === "lan" ? "loopback" : bind,
    customBindHost,
    basePath,
  });
  const devPort = mode === "dev" ? resolveDashboardDevPort(options, port) : port;
  const dashboardUrl =
    mode === "dev"
      ? buildDevDashboardUrl({ wsUrl: links.wsUrl, token: token || undefined, port: devPort })
      : // Prefer URL fragment to avoid leaking auth tokens via query params.
        token
        ? `${links.httpUrl}#token=${encodeURIComponent(token)}`
        : links.httpUrl;

  runtime.log(
    mode === "dev" ? `Dashboard dev URL: ${dashboardUrl}` : `Dashboard URL: ${dashboardUrl}`,
  );

  const copied = await copyToClipboard(dashboardUrl).catch(() => false);
  runtime.log(copied ? "Copied to clipboard." : "Copy to clipboard unavailable.");

  if (mode === "dev") {
    const repoRoot = resolveDashboardDevRepoRoot();
    if (!repoRoot) {
      throw new Error(
        "`openclaw dashboard dev` requires a source checkout. Run from the repo root, or use `pnpm ui:dev`.",
      );
    }

    const gatewayBootstrap = await ensureGatewayReachableForDashboardDev({
      repoRoot,
      runtime,
      wsUrl: links.wsUrl,
      token: token || undefined,
      password: password || undefined,
    });
    if (gatewayBootstrap.mode === "reused") {
      runtime.log(`Using existing gateway at ${links.wsUrl}.`);
    } else {
      runtime.log(`Using local gateway started by dashboard dev at ${links.wsUrl}.`);
    }

    try {
      let opened = false;
      if (!options.noOpen) {
        const browserSupport = await detectBrowserOpenSupport();
        if (browserSupport.ok) {
          opened = await openUrl(dashboardUrl);
        }
      } else {
        runtime.log("Browser launch disabled (--no-open). Use the URL above.");
      }

      if (opened) {
        runtime.log("Opened Vite dev dashboard. Keep this process running for HMR.");
      } else if (!options.noOpen) {
        runtime.log("Open the URL manually after Vite starts if your browser did not launch.");
      }

      runtime.log(`Starting Control UI dev server (Vite HMR) on port ${devPort}...`);
      await runUiDevServer({ repoRoot, port: devPort });
    } finally {
      if (gatewayBootstrap.process) {
        runtime.log("Stopping local gateway started by dashboard dev.");
        stopChildProcess(gatewayBootstrap.process);
      }
    }
    return;
  }

  let opened = false;
  let hint: string | undefined;
  if (!options.noOpen) {
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      opened = await openUrl(dashboardUrl);
    }
    if (!opened) {
      hint = formatControlUiSshHint({
        port,
        basePath,
        token: token || undefined,
      });
    }
  } else {
    hint = "Browser launch disabled (--no-open). Use the URL above.";
  }

  if (opened) {
    runtime.log("Opened in your browser. Keep that tab to control OpenClaw.");
  } else if (hint) {
    runtime.log(hint);
  }
}
