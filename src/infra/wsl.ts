// Detects Windows Subsystem for Linux environments.
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

let wslCached: boolean | null = null;

/** Clears the cached async WSL detection result between isolated tests. */
export function resetWSLStateForTests(): void {
  wslCached = null;
}

/** Detects WSL from environment variables without touching the filesystem. */
export function isWSLEnv(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.WSL_INTEROP || env.WSL_DISTRO_NAME || env.WSLENV);
}

/**
 * Synchronously detects WSL from env vars first, then `/proc/version`.
 */
export function isWSLSync(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  if (isWSLEnv()) {
    return true;
  }
  try {
    const release = normalizeLowercaseStringOrEmpty(readFileSync("/proc/version", "utf8"));
    return release.includes("microsoft") || release.includes("wsl");
  } catch {
    return false;
  }
}

/**
 * Synchronously detects WSL2 from kernel-version markers after WSL detection.
 */
export function isWSL2Sync(): boolean {
  if (!isWSLSync()) {
    return false;
  }
  try {
    const version = normalizeLowercaseStringOrEmpty(readFileSync("/proc/version", "utf8"));
    return version.includes("wsl2") || version.includes("microsoft-standard");
  } catch {
    return false;
  }
}

/** Asynchronously detects WSL from env vars and `/proc/sys/kernel/osrelease`, with process cache. */
export async function isWSL(
  environment: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {},
): Promise<boolean> {
  const cacheProcessEnvironment =
    environment.env === undefined && environment.platform === undefined;
  if (cacheProcessEnvironment && wslCached !== null) {
    return wslCached;
  }
  let detected = false;
  if ((environment.platform ?? process.platform) === "linux") {
    detected = isWSLEnv(environment.env ?? process.env);
    if (!detected) {
      try {
        const release = normalizeLowercaseStringOrEmpty(
          await fs.readFile("/proc/sys/kernel/osrelease", "utf8"),
        );
        detected = release.includes("microsoft") || release.includes("wsl");
      } catch {
        // Missing release information leaves the environment undetected.
      }
    }
  }
  if (cacheProcessEnvironment) {
    wslCached = detected;
  }
  return detected;
}
