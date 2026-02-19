import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { ensurePortAvailable } from "../infra/ports.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR } from "../utils.js";
import { appendCdpPath } from "./cdp.helpers.js";
import { getHeadersWithAuth, normalizeCdpWsUrl } from "./cdp.js";
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

export async function isChromeReachable(cdpUrl: string, timeoutMs = 500): Promise<boolean> {
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  return Boolean(version);
}

type ChromeVersion = {
  webSocketDebuggerUrl?: string;
  Browser?: string;
  "User-Agent"?: string;
};

async function fetchChromeVersion(cdpUrl: string, timeoutMs = 500): Promise<ChromeVersion | null> {
  const ctrl = new AbortController();
  const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
  try {
    const versionUrl = appendCdpPath(cdpUrl, "/json/version");
    const res = await fetch(versionUrl, {
      signal: ctrl.signal,
      headers: getHeadersWithAuth(versionUrl),
    });
    if (!res.ok) {
      return null;
    }
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
  timeoutMs = 500,
): Promise<string | null> {
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  const wsUrl = String(version?.webSocketDebuggerUrl ?? "").trim();
  if (!wsUrl) {
    return null;
  }
  return normalizeCdpWsUrl(wsUrl, cdpUrl);
}

async function canOpenWebSocket(wsUrl: string, timeoutMs = 800): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const headers = getHeadersWithAuth(wsUrl);
    const ws = new WebSocket(wsUrl, {
      handshakeTimeout: timeoutMs,
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    const timer = setTimeout(
      () => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        resolve(false);
      },
      Math.max(50, timeoutMs + 25),
    );
    ws.once("open", () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(true);
    });
    ws.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function isChromeCdpReady(
  cdpUrl: string,
  timeoutMs = 500,
  handshakeTimeoutMs = 800,
): Promise<boolean> {
  const wsUrl = await getChromeWebSocketUrl(cdpUrl, timeoutMs);
  if (!wsUrl) {
    return false;
  }
  return await canOpenWebSocket(wsUrl, handshakeTimeoutMs);
}

/**
 * Enable Fetch-based proxy auth on a single CDP session.
 *
 * Sends Fetch.enable with handleAuthRequests, then listens for authRequired
 * events and responds with stored credentials. Also continues paused requests
 * so normal traffic is not blocked.
 */
function enableFetchAuthOnSession(
  ws: WebSocket,
  sessionId: string,
  idCounter: { value: number },
): void {
  const send = (method: string, params: Record<string, unknown> = {}) => {
    const msg: Record<string, unknown> = {
      id: ++idCounter.value,
      method,
      params,
    };
    if (sessionId) {
      msg.sessionId = sessionId;
    }
    ws.send(JSON.stringify(msg));
  };

  send("Fetch.enable", {
    handleAuthRequests: true,
    patterns: [{ urlPattern: "*" }],
  });
}

/**
 * Set up CDP Fetch-based proxy authentication for all page targets.
 *
 * Chrome does not support proxy credentials via --proxy-server. When it hits a
 * 407 Proxy Authentication Required, the Fetch domain fires authRequired and we
 * respond with the configured credentials via Fetch.continueWithAuth.
 *
 * Fetch is a page-level CDP domain, so we connect to the browser WebSocket,
 * use Target.setDiscoverTargets to watch for new pages, attach to each one,
 * and enable Fetch on every page session. This ensures proxy auth works across
 * all tabs, not just the initial about:blank.
 */
async function setupCdpProxyAuth(profile: ResolvedBrowserProfile): Promise<void> {
  const { proxyCredentials, cdpPort } = profile;
  if (!proxyCredentials) {
    return;
  }

  const cdpBase = `http://127.0.0.1:${cdpPort}`;
  const versionRes = await fetch(appendCdpPath(cdpBase, "/json/version"));
  const version = (await versionRes.json()) as { webSocketDebuggerUrl?: string };
  const browserWsUrl = version.webSocketDebuggerUrl?.trim();
  if (!browserWsUrl) {
    throw new Error("no browser WebSocket URL for proxy auth setup");
  }

  const ws = new WebSocket(browserWsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const idCounter = { value: 0 };
  const enabledSessions = new Set<string>();

  const sendBrowser = (method: string, params: Record<string, unknown> = {}) => {
    ws.send(JSON.stringify({ id: ++idCounter.value, method, params }));
  };

  const sendSession = (sessionId: string, method: string, params: Record<string, unknown> = {}) => {
    ws.send(JSON.stringify({ id: ++idCounter.value, sessionId, method, params }));
  };

  // Handle all CDP messages from browser + forwarded session events.
  ws.on("message", (data: Buffer) => {
    let msg: {
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // New target discovered — attach to page targets.
    if (msg.method === "Target.targetCreated") {
      const info = msg.params?.targetInfo as { targetId?: string; type?: string } | undefined;
      if (info?.type === "page" && info.targetId) {
        sendBrowser("Target.attachToTarget", {
          targetId: info.targetId,
          flatten: true,
        });
      }
      return;
    }

    // Attached to a target — enable Fetch on the new session.
    if (msg.method === "Target.attachedToTarget") {
      const sessionId = msg.params?.sessionId as string | undefined;
      if (sessionId && !enabledSessions.has(sessionId)) {
        enabledSessions.add(sessionId);
        enableFetchAuthOnSession(ws, sessionId, idCounter);
      }
      return;
    }

    // Session-scoped events (Fetch.authRequired / Fetch.requestPaused).
    const sessionId = msg.sessionId;
    if (!sessionId) {
      return;
    }

    if (msg.method === "Fetch.authRequired") {
      const requestId = msg.params?.requestId as string;
      sendSession(sessionId, "Fetch.continueWithAuth", {
        requestId,
        authChallengeResponse: {
          response: "ProvideCredentials",
          username: proxyCredentials.username,
          password: proxyCredentials.password,
        },
      });
    } else if (msg.method === "Fetch.requestPaused") {
      const requestId = msg.params?.requestId as string;
      sendSession(sessionId, "Fetch.continueRequest", { requestId });
    }
  });

  // Auto-attach to existing and future targets.
  sendBrowser("Target.setDiscoverTargets", { discover: true });
  // Also attach to targets that already exist (the initial about:blank page).
  sendBrowser("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });

  log.info(`🔑 proxy auth handler installed for profile "${profile.name}"`);
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

    // Stealth: hide navigator.webdriver from automation detection (#80)
    args.push("--disable-blink-features=AutomationControlled");

    // Append user-configured extra arguments (e.g., stealth flags, window size)
    if (resolved.extraArgs.length > 0) {
      args.push(...resolved.extraArgs);
    }

    // Proxy: use profile-level proxy (falls back to global in resolveProfile)
    if (profile.proxy) {
      args.push(`--proxy-server=${profile.proxy}`);
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
    const deadline = Date.now() + 10_000;
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
    const exitDeadline = Date.now() + 5000;
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
  // Wait for CDP to come up.
  const readyDeadline = Date.now() + 15_000;
  while (Date.now() < readyDeadline) {
    if (await isChromeReachable(profile.cdpUrl, 500)) {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!(await isChromeReachable(profile.cdpUrl, 500))) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error(
      `Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}".`,
    );
  }

  // Set up proxy authentication via CDP if credentials are configured.
  // Chrome's --proxy-server does not support inline credentials, so we intercept
  // the 407 auth challenge via the Fetch domain and respond programmatically.
  if (profile.proxyCredentials) {
    try {
      await setupCdpProxyAuth(profile);
    } catch (err) {
      log.warn(`proxy auth setup failed for profile "${profile.name}": ${String(err)}`);
    }
  }

  const pid = proc.pid ?? -1;
  log.info(
    `🦞 openclaw browser started (${exe.kind}) profile "${profile.name}" on 127.0.0.1:${profile.cdpPort} (pid ${pid})`,
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

export async function stopOpenClawChrome(running: RunningChrome, timeoutMs = 2500) {
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
    if (!(await isChromeReachable(cdpUrlForPort(running.cdpPort), 200))) {
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
