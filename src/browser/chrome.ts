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

const CHROME_SINGLETON_ARTIFACTS = ["SingletonLock", "SingletonCookie", "SingletonSocket"] as const;

type SingletonLockOwner = {
  host: string;
  pid: number;
};

type SingletonLockState = {
  ownerRaw: string;
  owner: SingletonLockOwner | null;
};

function parseSingletonLockOwner(raw: string): SingletonLockOwner | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const sep = trimmed.lastIndexOf("-");
  if (sep <= 0 || sep === trimmed.length - 1) {
    return null;
  }
  const host = trimmed.slice(0, sep).trim();
  const pidRaw = trimmed.slice(sep + 1).trim();
  if (!host || !/^\d+$/.test(pidRaw)) {
    return null;
  }
  const pid = Number.parseInt(pidRaw, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return null;
  }
  return { host, pid };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // EPERM means the process exists but we are not allowed to signal it.
    return code === "EPERM";
  }
}

function readChromeSingletonLockState(userDataDir: string): SingletonLockState | null {
  const lockPath = path.join(userDataDir, "SingletonLock");

  let ownerRaw = "";
  try {
    const stat = fs.lstatSync(lockPath);
    ownerRaw = stat.isSymbolicLink()
      ? fs.readlinkSync(lockPath).trim()
      : fs.readFileSync(lockPath, "utf-8").trim();
  } catch {
    return null;
  }

  return {
    ownerRaw,
    owner: parseSingletonLockOwner(ownerRaw),
  };
}

function removeChromeSingletonArtifacts(userDataDir: string) {
  for (const artifact of CHROME_SINGLETON_ARTIFACTS) {
    try {
      fs.rmSync(path.join(userDataDir, artifact), { force: true });
    } catch {
      // ignore best-effort cleanup failures
    }
  }
}

export function cleanupStaleChromeSingletonArtifacts(
  userDataDir: string,
  deps?: {
    hostname?: string;
    isProcessAlive?: (pid: number) => boolean;
  },
): { removed: boolean; reason?: string; owner?: string } {
  const lockState = readChromeSingletonLockState(userDataDir);
  if (!lockState) {
    return { removed: false };
  }

  const owner = lockState.owner;
  if (!owner) {
    return { removed: false, owner: lockState.ownerRaw || undefined };
  }

  const hostname = deps?.hostname ?? os.hostname();
  const processAlive = deps?.isProcessAlive ?? isProcessAlive;
  if (owner.host !== hostname) {
    // Host mismatch alone is not enough to prove staleness. The profile dir may
    // live on shared storage and still be actively used by Chromium elsewhere.
    return { removed: false, owner: lockState.ownerRaw };
  }
  const reason = !processAlive(owner.pid) ? `owner pid is not running (${owner.pid})` : undefined;

  if (!reason) {
    return { removed: false, owner: lockState.ownerRaw };
  }

  removeChromeSingletonArtifacts(userDataDir);
  return { removed: true, reason, owner: lockState.ownerRaw };
}

type ChromeSingletonCleanupResult = ReturnType<typeof cleanupStaleChromeSingletonArtifacts>;

type BootstrapChromeProcess = Pick<
  ChildProcessWithoutNullStreams,
  "exitCode" | "kill" | "signalCode"
>;

function logStaleChromeSingletonCleanup(
  profileName: string,
  lockCleanup: ChromeSingletonCleanupResult,
) {
  if (!lockCleanup.removed) {
    return;
  }
  const reason = lockCleanup.reason ?? "stale singleton owner";
  const ownerDetail = lockCleanup.owner ? ` owner=${lockCleanup.owner}` : "";
  log.info(
    `removed stale Chromium singleton artifacts for profile "${profileName}" (${reason}${ownerDetail})`,
  );
}

function hasChromeProcessExited(proc: BootstrapChromeProcess) {
  return proc.exitCode != null || proc.signalCode != null;
}

async function waitForChromeProcessExit(
  proc: BootstrapChromeProcess,
  timeoutMs: number,
  pollMs = 50,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasChromeProcessExited(proc)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return hasChromeProcessExited(proc);
}

async function shutdownBootstrapChromeForLaunch(
  bootstrap: BootstrapChromeProcess,
  params: {
    userDataDir: string;
    profileName: string;
    cleanupSingletonArtifacts?: typeof cleanupStaleChromeSingletonArtifacts;
    exitTimeoutMs?: number;
    pollMs?: number;
  },
) {
  try {
    bootstrap.kill("SIGTERM");
  } catch {
    // ignore
  }

  const exitTimeoutMs = params.exitTimeoutMs ?? CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS;
  const pollMs = params.pollMs ?? 50;
  let exited = await waitForChromeProcessExit(bootstrap, exitTimeoutMs, pollMs);
  if (!exited) {
    try {
      bootstrap.kill("SIGKILL");
    } catch {
      // ignore
    }
    exited = await waitForChromeProcessExit(bootstrap, exitTimeoutMs, pollMs);
    if (!exited) {
      log.warn(`bootstrap Chromium for profile "${params.profileName}" did not exit after SIGKILL`);
    }
  }

  // Bootstrap can leave fresh singleton artifacts behind when it exits via signal.
  const cleanupSingletonArtifacts =
    params.cleanupSingletonArtifacts ?? cleanupStaleChromeSingletonArtifacts;
  logStaleChromeSingletonCleanup(params.profileName, cleanupSingletonArtifacts(params.userDataDir));
}

export const __testing = {
  shutdownBootstrapChromeForLaunch,
};

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
  logStaleChromeSingletonCleanup(profile.name, cleanupStaleChromeSingletonArtifacts(userDataDir));

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
    await shutdownBootstrapChromeForLaunch(bootstrap, {
      userDataDir,
      profileName: profile.name,
    });
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
