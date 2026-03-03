import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePortAvailable } from "../infra/ports.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR } from "../utils.js";
import { CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS, CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS, CHROME_LAUNCH_READY_POLL_MS, CHROME_LAUNCH_READY_WINDOW_MS, CHROME_REACHABILITY_TIMEOUT_MS, CHROME_STDERR_HINT_MAX_CHARS, CHROME_STOP_PROBE_TIMEOUT_MS, CHROME_STOP_TIMEOUT_MS, CHROME_WS_READY_TIMEOUT_MS, } from "./cdp-timeouts.js";
import { appendCdpPath, fetchCdpChecked, openCdpWebSocket } from "./cdp.helpers.js";
import { normalizeCdpWsUrl } from "./cdp.js";
import { resolveBrowserExecutableForPlatform, } from "./chrome.executables.js";
import { decorateOpenClawProfile, ensureProfileCleanExit, isProfileDecorated, } from "./chrome.profile-decoration.js";
import { DEFAULT_OPENCLAW_BROWSER_COLOR, DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME, } from "./constants.js";
const log = createSubsystemLogger("browser").child("chrome");
export { findChromeExecutableLinux, findChromeExecutableMac, findChromeExecutableWindows, resolveBrowserExecutableForPlatform, } from "./chrome.executables.js";
export { decorateOpenClawProfile, ensureProfileCleanExit, isProfileDecorated, } from "./chrome.profile-decoration.js";
function exists(filePath) {
    try {
        return fs.existsSync(filePath);
    }
    catch {
        return false;
    }
}
function resolveBrowserExecutable(resolved) {
    return resolveBrowserExecutableForPlatform(resolved, process.platform);
}
export function resolveOpenClawUserDataDir(profileName = DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME) {
    return path.join(CONFIG_DIR, "browser", profileName, "user-data");
}
function cdpUrlForPort(cdpPort) {
    return `http://127.0.0.1:${cdpPort}`;
}
export async function isChromeReachable(cdpUrl, timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS) {
    const version = await fetchChromeVersion(cdpUrl, timeoutMs);
    return Boolean(version);
}
async function fetchChromeVersion(cdpUrl, timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS) {
    const ctrl = new AbortController();
    const t = setTimeout(ctrl.abort.bind(ctrl), timeoutMs);
    try {
        const versionUrl = appendCdpPath(cdpUrl, "/json/version");
        const res = await fetchCdpChecked(versionUrl, timeoutMs, { signal: ctrl.signal });
        const data = (await res.json());
        if (!data || typeof data !== "object") {
            return null;
        }
        return data;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(t);
    }
}
export async function getChromeWebSocketUrl(cdpUrl, timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS) {
    const version = await fetchChromeVersion(cdpUrl, timeoutMs);
    const wsUrl = String(version?.webSocketDebuggerUrl ?? "").trim();
    if (!wsUrl) {
        return null;
    }
    return normalizeCdpWsUrl(wsUrl, cdpUrl);
}
async function canOpenWebSocket(wsUrl, timeoutMs = CHROME_WS_READY_TIMEOUT_MS) {
    return await new Promise((resolve) => {
        const ws = openCdpWebSocket(wsUrl, {
            handshakeTimeoutMs: timeoutMs,
        });
        const timer = setTimeout(() => {
            try {
                ws.terminate();
            }
            catch {
                // ignore
            }
            resolve(false);
        }, Math.max(50, timeoutMs + 25));
        ws.once("open", () => {
            clearTimeout(timer);
            try {
                ws.close();
            }
            catch {
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
export async function isChromeCdpReady(cdpUrl, timeoutMs = CHROME_REACHABILITY_TIMEOUT_MS, handshakeTimeoutMs = CHROME_WS_READY_TIMEOUT_MS) {
    const wsUrl = await getChromeWebSocketUrl(cdpUrl, timeoutMs);
    if (!wsUrl) {
        return false;
    }
    return await canOpenWebSocket(wsUrl, handshakeTimeoutMs);
}
export async function launchOpenClawChrome(resolved, profile) {
    if (!profile.cdpIsLoopback) {
        throw new Error(`Profile "${profile.name}" is remote; cannot launch local Chrome.`);
    }
    await ensurePortAvailable(profile.cdpPort);
    const exe = resolveBrowserExecutable(resolved);
    if (!exe) {
        throw new Error("No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).");
    }
    const userDataDir = resolveOpenClawUserDataDir(profile.name);
    fs.mkdirSync(userDataDir, { recursive: true });
    const needsDecorate = !isProfileDecorated(userDataDir, profile.name, (profile.color ?? DEFAULT_OPENCLAW_BROWSER_COLOR).toUpperCase());
    // First launch to create preference files if missing, then decorate and relaunch.
    const spawnOnce = () => {
        const args = [
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
        try {
            bootstrap.kill("SIGTERM");
        }
        catch {
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
        }
        catch (err) {
            log.warn(`openclaw browser profile decoration failed: ${String(err)}`);
        }
    }
    try {
        ensureProfileCleanExit(userDataDir);
    }
    catch (err) {
        log.warn(`openclaw browser clean-exit prefs failed: ${String(err)}`);
    }
    const proc = spawnOnce();
    // Collect stderr for diagnostics in case Chrome fails to start.
    // The listener is removed on success to avoid unbounded memory growth
    // from a long-lived Chrome process that emits periodic warnings.
    const stderrChunks = [];
    const onStderr = (chunk) => {
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
        const sandboxHint = process.platform === "linux" && !resolved.noSandbox
            ? "\nHint: If running in a container or as root, try setting browser.noSandbox: true in config."
            : "";
        try {
            proc.kill("SIGKILL");
        }
        catch {
            // ignore
        }
        throw new Error(`Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}".${sandboxHint}${stderrHint}`);
    }
    // Chrome started successfully — detach the stderr listener and release the buffer.
    proc.stderr?.off("data", onStderr);
    stderrChunks.length = 0;
    const pid = proc.pid ?? -1;
    log.info(`🦞 openclaw browser started (${exe.kind}) profile "${profile.name}" on 127.0.0.1:${profile.cdpPort} (pid ${pid})`);
    return {
        pid,
        exe,
        userDataDir,
        cdpPort: profile.cdpPort,
        startedAt,
        proc,
    };
}
export async function stopOpenClawChrome(running, timeoutMs = CHROME_STOP_TIMEOUT_MS) {
    const proc = running.proc;
    if (proc.killed) {
        return;
    }
    try {
        proc.kill("SIGTERM");
    }
    catch {
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
    }
    catch {
        // ignore
    }
}
