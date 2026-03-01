import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
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
const CHROME_CDP_READY_TIMEOUT_MS = 45_000;
const CHROME_PROCESS_OUTPUT_TAIL_BYTES = 4096;
const CHROME_CONFLICT_PROCESS_SHUTDOWN_TIMEOUT_MS = 3000;

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

function trimToLastBytes(value: string, maxBytes: number): string {
  if (value.length <= maxBytes) {
    return value;
  }
  return value.slice(-maxBytes);
}

function parsePidAndArgs(line: string): { pid: number; args: string } | null {
  const match = line.trim().match(/^(\d+)\s+(.*)$/);
  if (!match) {
    return null;
  }
  const pid = Number.parseInt(match[1] ?? "", 10);
  const args = (match[2] ?? "").trim();
  if (!Number.isFinite(pid) || pid <= 0 || !args) {
    return null;
  }
  return { pid, args };
}

function extractRemoteDebuggingPort(args: string): number | null {
  const match = args.match(/--remote-debugging-port=(\d+)/);
  if (!match?.[1]) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function findConflictingChromeProfileRootPids(params: {
  psOutput: string;
  userDataDir: string;
  expectedCdpPort: number;
}): number[] {
  const userDataDirFlag = `--user-data-dir=${params.userDataDir}`;
  const userDataDirQuotedFlag = `--user-data-dir="${params.userDataDir}"`;
  const pids = new Set<number>();
  for (const line of params.psOutput.split(/\r?\n/)) {
    const parsed = parsePidAndArgs(line);
    if (!parsed) {
      continue;
    }
    const args = parsed.args;
    if (
      !args.includes(userDataDirFlag) &&
      !args.includes(userDataDirQuotedFlag) &&
      !args.includes(params.userDataDir)
    ) {
      continue;
    }
    if (args.includes("--type=")) {
      continue;
    }
    if (
      !/(^|\s)(?:\S*\/)?(chrome|google-chrome|chromium|brave|msedge|microsoft-edge)(\s|$)/i.test(
        args,
      )
    ) {
      continue;
    }
    const debuggingPort = extractRemoteDebuggingPort(args);
    if (debuggingPort != null && debuggingPort === params.expectedCdpPort) {
      continue;
    }
    pids.add(parsed.pid);
  }
  return [...pids];
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code =
      typeof err === "object" && err && "code" in err
        ? String((err as { code?: string }).code)
        : "";
    return code !== "ESRCH";
  }
}

async function terminatePid(pid: number, timeoutMs: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return !isPidAlive(pid);
  }

  const deadline = Date.now() + Math.max(100, timeoutMs);
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
  const killDeadline = Date.now() + 1000;
  while (Date.now() < killDeadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isPidAlive(pid);
}

async function stopConflictingChromeProcesses(params: {
  userDataDir: string;
  expectedCdpPort: number;
  excludePid?: number;
}): Promise<number> {
  if (process.platform !== "linux") {
    return 0;
  }
  const res = spawnSync("ps", ["-eo", "pid,args"], {
    encoding: "utf8",
  });
  const output = String(res.stdout ?? "");
  if (!output.trim()) {
    return 0;
  }
  const pids = findConflictingChromeProfileRootPids({
    psOutput: output,
    userDataDir: params.userDataDir,
    expectedCdpPort: params.expectedCdpPort,
  }).filter((pid) => pid !== params.excludePid);

  let stopped = 0;
  for (const pid of pids) {
    if (await terminatePid(pid, CHROME_CONFLICT_PROCESS_SHUTDOWN_TIMEOUT_MS)) {
      stopped += 1;
    }
  }
  return stopped;
}

export function extractDevToolsListeningWsUrl(output: string): string | null {
  const match = output.match(/DevTools listening on (wss?:\/\/\S+)/i);
  const raw = match?.[1]?.trim();
  return raw ? raw : null;
}

function outputIndicatesExistingBrowserSession(output: string): boolean {
  return /opening in existing browser session/i.test(output);
}

function createProcessOutputTailBuffer(maxBytes: number) {
  let tail = "";
  return {
    append(chunk: unknown) {
      tail = trimToLastBytes(`${tail}${String(chunk)}`, maxBytes);
    },
    value() {
      return tail.trim();
    },
  };
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

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

async function fetchChromeVersionDirect(
  versionUrl: string,
  timeoutMs: number,
): Promise<ChromeVersion | null> {
  const parsed = new URL(versionUrl);
  const headers = getHeadersWithAuth(versionUrl);
  const client = parsed.protocol === "https:" ? https : http;
  return await new Promise<ChromeVersion | null>((resolve) => {
    const req = client.request(
      parsed,
      {
        method: "GET",
        headers,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          log.debug(`cdp /json/version not ok: ${status} (${versionUrl})`);
          resolve(null);
          return;
        }
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
          if (raw.length > 128 * 1024) {
            try {
              req.destroy(new Error("response too large"));
            } catch {
              // ignore
            }
          }
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(raw) as ChromeVersion;
            if (!data || typeof data !== "object") {
              log.debug(`cdp /json/version invalid payload (${versionUrl})`);
              resolve(null);
              return;
            }
            resolve(data);
          } catch (err) {
            log.debug(`cdp /json/version parse failed (${versionUrl}): ${String(err)}`);
            resolve(null);
          }
        });
      },
    );

    req.setTimeout(Math.max(1, timeoutMs), () => {
      try {
        req.destroy(new Error("timed out"));
      } catch {
        // ignore
      }
    });
    req.on("error", (err) => {
      log.debug(`cdp /json/version fetch failed (${versionUrl}): ${String(err)}`);
      resolve(null);
    });
    req.end();
  });
}

async function fetchChromeVersion(cdpUrl: string, timeoutMs = 500): Promise<ChromeVersion | null> {
  const versionUrl = appendCdpPath(cdpUrl, "/json/version");
  let loopbackTarget = false;
  try {
    const parsed = new URL(versionUrl);
    loopbackTarget = isLoopbackHostname(parsed.hostname);
  } catch {
    // ignore URL parse errors and let fetch handle/throw below
  }

  const ctrl = new AbortController();
  const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
  try {
    const res = await fetch(versionUrl, {
      signal: ctrl.signal,
      headers: getHeadersWithAuth(versionUrl),
    });
    if (!res.ok) {
      log.debug(`cdp /json/version not ok: ${res.status} (${versionUrl})`);
      return null;
    }
    const data = (await res.json()) as ChromeVersion;
    if (!data || typeof data !== "object") {
      log.debug(`cdp /json/version invalid payload (${versionUrl})`);
      return null;
    }
    return data;
  } catch (err) {
    if (loopbackTarget) {
      // Preserve mocked/global fetch behavior when it succeeds, but fall back
      // to direct loopback HTTP when fetch transport is unreliable in host envs.
      return await fetchChromeVersionDirect(versionUrl, timeoutMs);
    }
    log.debug(`cdp /json/version fetch failed (${versionUrl}): ${String(err)}`);
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

async function isChromeReadyFromProcessOutput(
  cdpUrl: string,
  processOutput: string,
): Promise<boolean> {
  const rawWsUrl = extractDevToolsListeningWsUrl(processOutput);
  if (!rawWsUrl) {
    return false;
  }
  try {
    const ws = new URL(rawWsUrl);
    const cdp = new URL(cdpUrl);
    const wsPort = ws.port || (ws.protocol === "wss:" ? "443" : "80");
    const cdpPort = cdp.port || (cdp.protocol === "https:" ? "443" : "80");
    return wsPort === cdpPort;
  } catch {
    return false;
  }
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

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const proc = spawnOnce();
    const outputTail = createProcessOutputTailBuffer(CHROME_PROCESS_OUTPUT_TAIL_BYTES);
    proc.stdout.on("data", (chunk) => outputTail.append(chunk));
    proc.stderr.on("data", (chunk) => outputTail.append(chunk));

    // Wait for CDP to come up.
    const readyDeadline = Date.now() + CHROME_CDP_READY_TIMEOUT_MS;
    let cdpReady = false;
    while (Date.now() < readyDeadline) {
      if (await isChromeReachable(profile.cdpUrl, 500)) {
        cdpReady = true;
        break;
      }
      if (await isChromeReadyFromProcessOutput(profile.cdpUrl, outputTail.value())) {
        cdpReady = true;
        break;
      }
      if (proc.exitCode != null || proc.signalCode != null) {
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!cdpReady && (await isChromeReachable(profile.cdpUrl, 1000))) {
      cdpReady = true;
    }
    if (!cdpReady && (await isChromeReadyFromProcessOutput(profile.cdpUrl, outputTail.value()))) {
      cdpReady = true;
    }

    if (cdpReady) {
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

    if (proc.exitCode == null && proc.signalCode == null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
    }

    const lifecycle =
      proc.signalCode != null
        ? `Chrome process exited via signal ${proc.signalCode}`
        : proc.exitCode != null
          ? `Chrome process exited with code ${proc.exitCode}`
          : `Chrome process did not expose CDP within ${CHROME_CDP_READY_TIMEOUT_MS}ms`;
    const tail = outputTail.value();
    const existingSessionConflict =
      proc.exitCode === 0 && outputIndicatesExistingBrowserSession(tail);
    if (attempt === 1 && existingSessionConflict) {
      const stopped = await stopConflictingChromeProcesses({
        userDataDir,
        expectedCdpPort: profile.cdpPort,
        excludePid: proc.pid ?? undefined,
      });
      if (stopped > 0) {
        log.warn(
          `Detected existing Chrome session for profile "${profile.name}" (${stopped} conflicting process(es) stopped); retrying launch.`,
        );
        continue;
      }
    }

    throw new Error(
      [
        `Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}".`,
        lifecycle,
        tail ? `Chrome output (tail): ${tail}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  throw new Error(
    `Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}".`,
  );
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
