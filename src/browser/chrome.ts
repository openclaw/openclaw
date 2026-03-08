import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

/**
 * Enable Fetch-based proxy auth on a single CDP session.
 *
 * Sends Fetch.enable with handleAuthRequests, then listens for authRequired
 * events and responds with stored credentials. Also continues paused requests
 * so normal traffic is not blocked.
 */
function enableFetchAuthOnSession(
  sendSessionAwait: (
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
  ) => Promise<void>,
  sessionId: string,
): Promise<void> {
  return sendSessionAwait(sessionId, "Fetch.enable", {
    handleAuthRequests: true,
    patterns: [{ urlPattern: "*" }],
  });
}

type CdpAuthChallengeResponse =
  | {
      response: "ProvideCredentials";
      username: string;
      password: string;
    }
  | {
      response: "Default";
    };

export function resolveProxyAuthChallengeResponse(
  challengeSource: unknown,
  proxyCredentials: { username: string; password: string },
): CdpAuthChallengeResponse {
  const source = typeof challengeSource === "string" ? challengeSource.toLowerCase() : "";
  if (source !== "proxy") {
    return { response: "Default" };
  }
  return {
    response: "ProvideCredentials",
    username: proxyCredentials.username,
    password: proxyCredentials.password,
  };
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
async function setupCdpProxyAuth(
  profile: ResolvedBrowserProfile,
  proc: ChildProcessWithoutNullStreams,
): Promise<void> {
  const { proxyCredentials, cdpPort } = profile;
  if (!proxyCredentials) {
    return;
  }

  const cdpBase = `http://127.0.0.1:${cdpPort}`;
  const browserWsUrl = await getChromeWebSocketUrl(cdpBase);
  if (!browserWsUrl) {
    throw new Error("no browser WebSocket URL for proxy auth setup");
  }

  const ws = openCdpWebSocket(browserWsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  ws.on("error", (err) => {
    log.warn(`proxy auth WebSocket error for profile "${profile.name}": ${String(err)}`);
  });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    try {
      ws.close();
    } catch {
      // ignore
    }
    if (ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
  };

  proc.once("exit", cleanup);
  proc.once("close", cleanup);
  proc.once("error", cleanup);

  const idCounter = { value: 0 };
  const enabledSessions = new Set<string>();
  const pendingAcks = new Map<
    number,
    {
      method: string;
      resolve: () => void;
      reject: (err: Error) => void;
    }
  >();

  const sendBrowser = (method: string, params: Record<string, unknown> = {}) => {
    ws.send(JSON.stringify({ id: ++idCounter.value, method, params }));
  };

  const sendSession = (sessionId: string, method: string, params: Record<string, unknown> = {}) => {
    ws.send(JSON.stringify({ id: ++idCounter.value, sessionId, method, params }));
  };

  const sendBrowserAwait = async (method: string, params: Record<string, unknown> = {}) => {
    const id = ++idCounter.value;
    await new Promise<void>((resolve, reject) => {
      pendingAcks.set(id, { method, resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const sendSessionAwait = async (
    sessionId: string,
    method: string,
    params: Record<string, unknown> = {},
  ) => {
    const id = ++idCounter.value;
    await new Promise<void>((resolve, reject) => {
      pendingAcks.set(id, { method: `${sessionId}:${method}`, resolve, reject });
      ws.send(JSON.stringify({ id, sessionId, method, params }));
    });
  };

  let firstFetchEnabledSettled = false;
  let resolveFirstFetchEnabled: () => void = () => {};
  let rejectFirstFetchEnabled: (err: Error) => void = () => {};
  const firstFetchEnabled = new Promise<void>((resolve, reject) => {
    resolveFirstFetchEnabled = () => {
      if (firstFetchEnabledSettled) {
        return;
      }
      firstFetchEnabledSettled = true;
      resolve();
    };
    rejectFirstFetchEnabled = (err: Error) => {
      if (firstFetchEnabledSettled) {
        return;
      }
      firstFetchEnabledSettled = true;
      reject(err);
    };
  });

  const firstFetchEnabledTimeout = setTimeout(() => {
    rejectFirstFetchEnabled(
      new Error(`timed out waiting for proxy auth hooks for profile "${profile.name}"`),
    );
  }, 1_500);

  const rejectPendingAcks = (reason: string) => {
    for (const [id, pending] of pendingAcks) {
      pendingAcks.delete(id);
      pending.reject(new Error(reason));
    }
  };

  ws.on("close", () => {
    rejectPendingAcks(`proxy auth WebSocket closed for profile "${profile.name}"`);
    rejectFirstFetchEnabled(
      new Error(
        `proxy auth WebSocket closed before hooks were ready for profile "${profile.name}"`,
      ),
    );
  });

  // Handle all CDP messages from browser + forwarded session events.
  ws.on("message", (data: Buffer) => {
    let msg: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (typeof msg.id === "number") {
      const pending = pendingAcks.get(msg.id);
      if (!pending) {
        return;
      }
      pendingAcks.delete(msg.id);
      if (msg.error) {
        pending.reject(
          new Error(`CDP ${pending.method} failed: ${msg.error.message ?? "unknown"}`),
        );
      } else {
        pending.resolve();
      }
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
      const targetType = (msg.params?.targetInfo as { type?: string } | undefined)?.type;
      if (sessionId && !enabledSessions.has(sessionId)) {
        enabledSessions.add(sessionId);
        void enableFetchAuthOnSession(sendSessionAwait, sessionId)
          .then(() => {
            // Only gate launch readiness on page targets — a worker or
            // service-worker resolving first would leave the initial page
            // without Fetch.enable, racing into a 407.
            if (targetType === "page") {
              resolveFirstFetchEnabled();
            }
          })
          .catch((err) => {
            rejectFirstFetchEnabled(err instanceof Error ? err : new Error(String(err)));
          });
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
      const challengeSource = (msg.params?.authChallenge as { source?: string } | undefined)
        ?.source;
      // Only answer proxy (407) challenges with proxy credentials.
      // For origin server auth (401), fall back to browser default handling.
      sendSession(sessionId, "Fetch.continueWithAuth", {
        requestId,
        authChallengeResponse: resolveProxyAuthChallengeResponse(challengeSource, proxyCredentials),
      });
    } else if (msg.method === "Fetch.requestPaused") {
      const requestId = msg.params?.requestId as string;
      sendSession(sessionId, "Fetch.continueRequest", { requestId });
    }
  });

  try {
    // Auto-attach to existing and future targets.
    await sendBrowserAwait("Target.setDiscoverTargets", { discover: true });
    // Also attach to targets that already exist (the initial about:blank page).
    await sendBrowserAwait("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });

    await firstFetchEnabled;
  } finally {
    clearTimeout(firstFetchEnabledTimeout);
  }

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
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error(
      `Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}".${sandboxHint}${stderrHint}`,
    );
  }

  // Chrome started successfully — detach the stderr listener and release the buffer.
  proc.stderr?.off("data", onStderr);
  stderrChunks.length = 0;

  // Set up proxy authentication via CDP if credentials are configured.
  // Chrome's --proxy-server does not support inline credentials, so we intercept
  // the 407 auth challenge via the Fetch domain and respond programmatically.
  if (profile.proxyCredentials) {
    try {
      await setupCdpProxyAuth(profile, proc);
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
