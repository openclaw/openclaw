/**
 * Auto-Launch & Auto-Connect
 * 
 * Automatically launches Chrome and connects the OpenClaw extension
 * without manual intervention.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import type { ResolvedBrowserProfile } from "./config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("browser").child("auto-launch");

export type AutoLaunchConfig = {
  /** Enable auto-launch */
  enabled: boolean;
  /** Auto-connect extension after launch */
  autoConnect: boolean;
  /** Keep Chrome alive (restart if crashes) */
  keepAlive: boolean;
  /** Launch delay before connecting extension (ms) */
  launchDelayMs: number;
  /** Chrome executable path override */
  executablePath?: string;
};

export type LaunchResult = {
  success: boolean;
  reason: string;
  chromePath?: string;
  pid?: number;
};

export const DEFAULT_CONFIG: AutoLaunchConfig = {
  enabled: false, // Disabled by default (opt-in)
  autoConnect: true,
  keepAlive: false,
  launchDelayMs: 2000, // 2 seconds
};

/**
 * Common Chrome installation paths by platform
 */
const CHROME_PATHS: Record<string, string[]> = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
    process.env.PROGRAMFILES + "\\Google\\Chrome\\Application\\chrome.exe",
  ].filter((p) => p && !p.includes("undefined")),
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
};

/**
 * Detect Chrome installation
 */
export function detectChrome(customPath?: string): string | null {
  if (customPath && existsSync(customPath)) {
    return customPath;
  }

  const platformKey = platform();
  const paths = CHROME_PATHS[platformKey] || [];

  for (const path of paths) {
    if (existsSync(path)) {
      log.debug(`Found Chrome at: ${path}`);
      return path;
    }
  }

  log.warn(`Chrome not found in standard locations for ${platformKey}`);
  return null;
}

/**
 * Check if Chrome is already running
 */
export async function isChromeRunning(): Promise<boolean> {
  const platformKey = platform();

  try {
    if (platformKey === "win32") {
      // Windows: check tasklist
      const { execSync } = await import("node:child_process");
      const result = execSync('tasklist /FI "IMAGENAME eq chrome.exe"', {
        encoding: "utf8",
      });
      return result.includes("chrome.exe");
    } else if (platformKey === "darwin") {
      // macOS: check pgrep (more reliable than grep)
      const { execSync } = await import("node:child_process");
      try {
        execSync('pgrep -i "Google Chrome"', { encoding: "utf8" });
        return true; // pgrep found process
      } catch {
        return false; // pgrep found nothing (exit code 1)
      }
    } else {
      // Linux: check pgrep (more reliable than grep)
      const { execSync } = await import("node:child_process");
      try {
        execSync("pgrep chrome", { encoding: "utf8" });
        return true; // pgrep found process
      } catch {
        return false; // pgrep found nothing (exit code 1)
      }
    }
  } catch {
    // If command fails unexpectedly, assume Chrome is not running
    return false;
  }
}

/**
 * Get Chrome launch arguments
 */
function getChromeLaunchArgs(
  profile: ResolvedBrowserProfile,
  extensionPath?: string
): string[] {
  const args = [
    `--remote-debugging-port=${profile.cdpPort}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  // Load OpenClaw Browser Relay extension if path provided
  if (extensionPath && existsSync(extensionPath)) {
    args.push(`--load-extension=${extensionPath}`);
    log.debug(`[${profile.name}] Loading extension from: ${extensionPath}`);
  }

  return args;
}

/**
 * Get OpenClaw extension path
 */
function getExtensionPath(): string | undefined {
  // Try to find extension relative to OpenClaw installation
  const paths = [
    // Relative to node_modules (when running from npm)
    process.cwd() + "/assets/chrome-extension",
    process.cwd() + "/../assets/chrome-extension",
    // Relative to workspace
    process.env.HOME + "/.openclaw/workspace/openclaw-dev/assets/chrome-extension",
    // Windows paths
    process.env.USERPROFILE + "\\.openclaw\\workspace\\openclaw-dev\\assets\\chrome-extension",
  ].filter((p) => p && !p.includes("undefined"));

  for (const path of paths) {
    const manifestPath = path + "/manifest.json";
    if (existsSync(manifestPath)) {
      log.debug(`Found extension at: ${path}`);
      return path;
    }
  }

  log.warn("OpenClaw extension not found in standard locations");
  return undefined;
}

/**
 * Launch Chrome
 */
export async function launchChrome(
  profile: ResolvedBrowserProfile,
  config: AutoLaunchConfig
): Promise<LaunchResult> {
  if (!config.enabled) {
    return {
      success: false,
      reason: "Auto-launch disabled",
    };
  }

  // Detect Chrome
  const chromePath = detectChrome(config.executablePath);
  if (!chromePath) {
    return {
      success: false,
      reason: "Chrome not found",
    };
  }

  // Check if already running
  const alreadyRunning = await isChromeRunning();
  if (alreadyRunning) {
    log.info(`[${profile.name}] Chrome already running, skipping launch`);
    return {
      success: true,
      reason: "Chrome already running",
      chromePath,
    };
  }

  // Get extension path
  const extensionPath = getExtensionPath();
  if (extensionPath) {
    log.info(`[${profile.name}] Will load extension from: ${extensionPath}`);
  }

  // Launch Chrome
  const args = getChromeLaunchArgs(profile, extensionPath);

  log.info(
    `[${profile.name}] Launching Chrome at ${chromePath} with CDP port ${profile.cdpPort}`
  );

  try {
    const child = spawn(chromePath, args, {
      detached: true,
      stdio: "ignore",
    });

    // Unref so process doesn't keep parent alive
    child.unref();

    log.info(`[${profile.name}] Chrome launched (PID: ${child.pid})`);

    if (extensionPath) {
      log.info(
        `[${profile.name}] Extension loaded - will auto-connect to relay server`
      );
    }

    return {
      success: true,
      reason: "Chrome launched successfully",
      chromePath,
      pid: child.pid,
    };
  } catch (err) {
    log.error(`[${profile.name}] Failed to launch Chrome: ${String(err)}`);
    return {
      success: false,
      reason: `Launch failed: ${String(err)}`,
      chromePath,
    };
  }
}

/**
 * Wait for Chrome to be ready (CDP available)
 */
export async function waitForChromeReady(
  profile: ResolvedBrowserProfile,
  timeoutMs = 10000
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      // Try to fetch CDP version endpoint
      const response = await fetch(
        `http://${profile.cdpHost}:${profile.cdpPort}/json/version`,
        { signal: AbortSignal.timeout(1000) }
      );

      if (response.ok) {
        log.info(`[${profile.name}] Chrome CDP ready`);
        return true;
      }
    } catch {
      // Not ready yet, wait and retry
    }

    // Wait 500ms before retrying
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  log.warn(`[${profile.name}] Chrome CDP not ready after ${timeoutMs}ms`);
  return false;
}

/**
 * Auto-launch Chrome if not running
 */
export async function autoLaunchChrome(
  profile: ResolvedBrowserProfile,
  config: AutoLaunchConfig = DEFAULT_CONFIG
): Promise<LaunchResult> {
  if (!config.enabled) {
    return {
      success: false,
      reason: "Auto-launch disabled",
    };
  }

  // Launch Chrome
  const result = await launchChrome(profile, config);

  if (!result.success) {
    return result;
  }

  // Wait for Chrome to be ready
  if (result.reason !== "Chrome already running") {
    log.info(`[${profile.name}] Waiting for Chrome to be ready...`);

    // Wait the configured launch delay
    await new Promise((resolve) => setTimeout(resolve, config.launchDelayMs));

    const ready = await waitForChromeReady(profile, 10000);

    if (!ready) {
      return {
        success: false,
        reason: "Chrome launched but CDP not responding",
        chromePath: result.chromePath,
        pid: result.pid,
      };
    }
  }

  log.info(`[${profile.name}] Chrome ready for use`);

  return {
    success: true,
    reason: "Chrome launched and ready",
    chromePath: result.chromePath,
    pid: result.pid,
  };
}

/**
 * Get default auto-launch configuration
 */
export function getDefaultConfig(): AutoLaunchConfig {
  return { ...DEFAULT_CONFIG };
}

/**
 * Format launch result for logging
 */
export function formatLaunchResult(result: LaunchResult): string {
  if (result.success) {
    const pid = result.pid ? ` (PID: ${result.pid})` : "";
    return `✓ ${result.reason}${pid}`;
  }

  return `✗ ${result.reason}`;
}
