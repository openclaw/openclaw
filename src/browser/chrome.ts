import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import type { BrowserProfileProxyConfig } from "../config/types.browser.js";
import { resolveConfiguredSecretInputString } from "../gateway/resolve-configured-secret-input-string.js";
import { ensurePortAvailable } from "../infra/ports.js";
import { rawDataToString } from "../infra/ws.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR } from "../utils.js";
import {
  CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS,
  CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS,
  CHROME_LAUNCH_READY_POLL_MS,
  CHROME_LAUNCH_READY_WINDOW_MS,
  CHROME_REACHABILITY_TIMEOUT_MS,
  CHROME_STDERR_HINT_MAX_CHARS,
  CHROME_STOP_PROBE_TIMEOUT_MS,
  CHROME_STOP_TIMEOUT_MS,
  CHROME_WS_READY_TIMEOUT_MS,
} from "./cdp-timeouts.js";
import { appendCdpPath, fetchCdpChecked, openCdpWebSocket } from "./cdp.helpers.js";
import { normalizeCdpWsUrl } from "./cdp.js";
import {
  type BrowserExecutable,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
import {
  decorateOpenClawProfile,
  ensureProfileCleanExit,
  isProfileDecorated,
} from "./chrome.profile-decoration.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";
import {
  DEFAULT_OPENCLAW_BROWSER_COLOR,
  DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME,
} from "./constants.js";

const log = createSubsystemLogger("browser").child("chrome");

export type { BrowserExecutable } from "./chrome.executables.js";
export {
  findChromeExecutableLinux,
  findChromeExecutableMac,
  findChromeExecutableWindows,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
export {
  decorateOpenClawProfile,
  ensureProfileCleanExit,
  isProfileDecorated,
} from "./chrome.profile-decoration.js";

function exists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export type RunningChrome = {
  pid: number;
  exe: BrowserExecutable;
  userDataDir: string;
  cdpPort: number;
  startedAt: number;
  proc: ChildProcessWithoutNullStreams;
};

function resolveBrowserExecutable(resolved: ResolvedBrowserConfig): BrowserExecutable | null {
  return resolveBrowserExecutableForPlatform(resolved, process.platform);
}

export function resolveOpenClawUserDataDir(profileName = DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME) {
  return path.join(CONFIG_DIR, "browser", profileName, "user-data");
}

function cdpUrlForPort(cdpPort: number) {
  return `http://127.0.0.1:${cdpPort}`;
}

type ResolvedProfileProxy = {
  server: string;
  diagnosticLabel: string;
  hasCredentials: boolean;
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasServerField(value: unknown): value is { server: unknown } {
  return isObjectRecord(value) && Object.hasOwn(value, "server");
}

async function resolveProxySecretInput(params: {
  value: unknown;
  path: string;
  required?: boolean;
  config: ReturnType<typeof loadConfig>;
}) {
  const resolved = await resolveConfiguredSecretInputString({
    config: params.config,
    env: process.env,
    value: params.value,
    path: params.path,
    unresolvedReasonStyle: "detailed",
  });

  if (resolved.unresolvedRefReason) {
    throw new Error(resolved.unresolvedRefReason);
  }
  if (resolved.value) {
    return resolved.value;
  }
  if (params.required) {
    throw new Error(`${params.path} is required.`);
  }
  return undefined;
}

function parseProxyServerUrl(rawServer: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawServer);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:" && protocol !== "socks5:") {
    throw new Error(`${label} must use http://, https://, or socks5://.`);
  }
  if (!parsed.hostname) {
    throw new Error(`${label} must include a hostname.`);
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    throw new Error(`${label} must not include a path.`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${label} must not include query or hash segments.`);
  }
  return parsed;
}

function formatProxyDiagnosticLabel(proxyUrl: URL): string {
  const protocol = proxyUrl.protocol.replace(":", "");
  const host = proxyUrl.hostname.includes(":") ? `[${proxyUrl.hostname}]` : proxyUrl.hostname;
  const defaultPort =
    proxyUrl.protocol === "https:"
      ? "443"
      : proxyUrl.protocol === "http:"
        ? "80"
        : proxyUrl.protocol === "socks5:"
          ? "1080"
          : "";
  const port = proxyUrl.port || defaultPort;
  return port ? `${protocol}://${host}:${port}` : `${protocol}://${host}`;
}

async function resolveProfileProxy(
  profileName: string,
  proxyConfig: BrowserProfileProxyConfig | undefined,
): Promise<ResolvedProfileProxy | undefined> {
  if (!proxyConfig) {
    return undefined;
  }

  const basePath = `browser.profiles.${profileName}.proxy`;
  const isStructured = hasServerField(proxyConfig);
  const cfg = loadConfig();
  const rawServer = isStructured ? proxyConfig.server : proxyConfig;
  const rawUsername = isStructured ? proxyConfig.username : undefined;
  const rawPassword = isStructured ? proxyConfig.password : undefined;

  const server = await resolveProxySecretInput({
    value: rawServer,
    path: isStructured ? `${basePath}.server` : basePath,
    required: true,
    config: cfg,
  });
  const username = await resolveProxySecretInput({
    value: rawUsername,
    path: `${basePath}.username`,
    config: cfg,
  });
  const password = await resolveProxySecretInput({
    value: rawPassword,
    path: `${basePath}.password`,
    config: cfg,
  });

  const parsed = parseProxyServerUrl(server, isStructured ? `${basePath}.server` : basePath);

  if (isStructured) {
    parsed.username = username ?? "";
    parsed.password = password ?? "";
  }

  const normalizedServer = parsed.toString().replace(/\/$/, "");

  return {
    server: normalizedServer,
    diagnosticLabel: formatProxyDiagnosticLabel(parsed),
    hasCredentials: parsed.username.length > 0 || parsed.password.length > 0,
  };
}

export async function isChromeReachable(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
): Promise<boolean> {
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  return Boolean(version);
}

type ChromeVersion = {
  webSocketDebuggerUrl?: string;
  Browser?: string;
  "User-Agent"?: string;
};

async function fetchChromeVersion(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
): Promise<ChromeVersion | null> {
  const ctrl = new AbortController();
  const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
  try {
    const versionUrl = appendCdpPath(cdpUrl, "/json/version");
    const res = await fetchCdpChecked(versionUrl, timeoutMs, { signal: ctrl.signal });
    const data = (await res.json()) as ChromeVersion;
    if (!data || typeof data !== "object") {
      return null;
    }
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function getChromeWebSocketUrl(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
): Promise<string | null> {
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  const wsUrl = String(version?.webSocketDebuggerUrl ?? "").trim();
  if (!wsUrl) {
    return null;
  }
  return normalizeCdpWsUrl(wsUrl, cdpUrl);
}

async function canRunCdpHealthCommand(
  wsUrl: string,
  timeoutMs = CHROME_WS_READY_TIMEOUT_MS,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const ws = openCdpWebSocket(wsUrl, {
      handshakeTimeoutMs: timeoutMs,
    });
    let settled = false;
    const onMessage = (raw: Parameters<typeof rawDataToString>[0]) => {
      if (settled) {
        return;
      }
      let parsed: { id?: unknown; result?: unknown } | null = null;
      try {
        parsed = JSON.parse(rawDataToString(raw)) as { id?: unknown; result?: unknown };
      } catch {
        return;
      }
      if (parsed?.id !== 1) {
        return;
      }
      finish(Boolean(parsed.result && typeof parsed.result === "object"));
    };

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      ws.off("message", onMessage);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(value);
    };
    const timer = setTimeout(
      () => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        finish(false);
      },
      Math.max(50, timeoutMs + 25),
    );

    ws.once("open", () => {
      try {
        ws.send(
          JSON.stringify({
            id: 1,
            method: "Browser.getVersion",
          }),
        );
      } catch {
        finish(false);
      }
    });

    ws.on("message", onMessage);

    ws.once("error", () => {
      finish(false);
    });
    ws.once("close", () => {
      finish(false);
    });
  });
}

export async function isChromeCdpReady(
  cdpUrl: string,
  timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS,
  handshakeTimeoutMs = CHROME_WS_READY_TIMEOUT_MS,
): Promise<boolean> {
  const wsUrl = await getChromeWebSocketUrl(cdpUrl, timeoutMs);
  if (!wsUrl) {
    return false;
  }
  return await canRunCdpHealthCommand(wsUrl, handshakeTimeoutMs);
}

export async function launchOpenClawChrome(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
): Promise<RunningChrome> {
  if (!profile.cdpIsLoopback) {
    throw new Error(`Profile "${profile.name}" is remote; cannot launch local Chrome.`);
  }
  await ensurePortAvailable(profile.cdpPort);

  const exe = resolveBrowserExecutable(resolved);
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).",
    );
  }

  const userDataDir = resolveOpenClawUserDataDir(profile.name);
  fs.mkdirSync(userDataDir, { recursive: true });
  let resolvedProxy: ResolvedProfileProxy | undefined;
  try {
    resolvedProxy = await resolveProfileProxy(profile.name, profile.proxy);
  } catch (err) {
    throw new Error(
      `Failed to resolve browser proxy for profile "${profile.name}": ${String(err)}`,
      { cause: err },
    );
  }

  const needsDecorate = !isProfileDecorated(
    userDataDir,
    profile.name,
    (profile.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR).toUpperCase(),
  );

  // First launch to create preference files if missing, then decorate and relaunch.
  const spawnOnce = () => {
    const args: string[] = [
      `--remote-debugging-port=${profile.cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-features=Translate,MediaRouter",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "--password-store=basic",
    ];

    if (resolved.headless) {
      // Best-effort; older Chromes may ignore.
      args.push("--headless=new");
      args.push("--disable-gpu");
    }
    if (resolved.noSandbox) {
      args.push("--no-sandbox");
      args.push("--disable-setuid-sandbox");
    }
    if (process.platform === "linux") {
      args.push("--disable-dev-shm-usage");
    }
    if (resolvedProxy) {
      args.push(`--proxy-server=${resolvedProxy.server}`);
    }

    // Append user-configured extra arguments (e.g., stealth flags, window size)
    if (resolved.extraArgs.length > 0) {
      args.push(...resolved.extraArgs);
    }

    // Always open a blank tab to ensure a target exists.
    args.push("about:blank");

    return spawn(exe.path, args, {
      stdio: "pipe",
      env: {
        ...process.env,
        // Reduce accidental sharing with the user's env.
        HOME: os.homedir(),
      },
    });
  };

  const startedAt = Date.now();

  const localStatePath = path.join(userDataDir, "Local State");
  const preferencesPath = path.join(userDataDir, "Default", "Preferences");
  const needsBootstrap = !exists(localStatePath) || !exists(preferencesPath);

  // If the profile doesn't exist yet, bootstrap it once so Chrome creates defaults.
  // Then decorate (if needed) before the "real" run.
  if (needsBootstrap) {
    const bootstrap = spawnOnce();
    const deadline = Date.now() + CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exists(localStatePath) && exists(preferencesPath)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      bootstrap.kill("SIGTERM");
    } catch {
      // ignore
    }
    const exitDeadline = Date.now() + CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS;
    while (Date.now() < exitDeadline) {
      if (bootstrap.exitCode != null) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  if (needsDecorate) {
    try {
      decorateOpenClawProfile(userDataDir, {
        name: profile.name,
        color: profile.color,
      });
      log.info(`🦞 openclaw browser profile decorated (${profile.color})`);
    } catch (err) {
      log.warn(`openclaw browser profile decoration failed: ${String(err)}`);
    }
  }

  try {
    ensureProfileCleanExit(userDataDir);
  } catch (err) {
    log.warn(`openclaw browser clean-exit prefs failed: ${String(err)}`);
  }

  const proc = spawnOnce();

  // Collect stderr for diagnostics in case Chrome fails to start.
  // The listener is removed on success to avoid unbounded memory growth
  // from a long-lived Chrome process that emits periodic warnings.
  const stderrChunks: Buffer[] = [];
  const onStderr = (chunk: Buffer) => {
    stderrChunks.push(chunk);
  };
  proc.stderr?.on("data", onStderr);

  // Wait for CDP to come up.
  const readyDeadline = Date.now() + CHROME_LAUNCH_READY_WINDOW_MS;
  while (Date.now() < readyDeadline) {
    if (await isChromeReachable(profile.cdpUrl)) {
      break;
    }
    await new Promise((r) => setTimeout(r, CHROME_LAUNCH_READY_POLL_MS));
  }

  if (!(await isChromeReachable(profile.cdpUrl))) {
    const stderrOutput = Buffer.concat(stderrChunks).toString("utf8").trim();
    const stderrHint = stderrOutput
      ? `\nChrome stderr:\n${stderrOutput.slice(0, CHROME_STDERR_HINT_MAX_CHARS)}`
      : "";
    const sandboxHint =
      process.platform === "linux" && !resolved.noSandbox
        ? "\nHint: If running in a container or as root, try setting browser.noSandbox: true in config."
        : "";
    const proxyHint = resolvedProxy
      ? `\nProxy: ${resolvedProxy.diagnosticLabel}\nHint: Verify proxy reachability and credentials for profile "${profile.name}".`
      : "";
    const proxyAuthHint =
      resolvedProxy?.hasCredentials === true
        ? "\nHint: This proxy includes credentials; verify auth method and username/password values."
        : "";
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error(
      `Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}".${sandboxHint}${proxyHint}${proxyAuthHint}${stderrHint}`,
    );
  }

  // Chrome started successfully — detach the stderr listener and release the buffer.
  proc.stderr?.off("data", onStderr);
  stderrChunks.length = 0;

  const pid = proc.pid ?? -1;
  const proxySuffix = resolvedProxy ? ` via proxy ${resolvedProxy.diagnosticLabel}` : "";
  log.info(
    `🦞 openclaw browser started (${exe.kind}) profile "${profile.name}" on 127.0.0.1:${profile.cdpPort}${proxySuffix} (pid ${pid})`,
  );

  return {
    pid,
    exe,
    userDataDir,
    cdpPort: profile.cdpPort,
    startedAt,
    proc,
  };
}

export async function stopOpenClawChrome(
  running: RunningChrome,
  timeoutMs = CHROME_STOP_TIMEOUT_MS,
) {
  const proc = running.proc;
  if (proc.killed) {
    return;
  }
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!proc.exitCode && proc.killed) {
      break;
    }
    if (!(await isChromeReachable(cdpUrlForPort(running.cdpPort), CHROME_STOP_PROBE_TIMEOUT_MS))) {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
}
