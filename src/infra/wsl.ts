import fs from "node:fs/promises";
import { release, version } from "node:os";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

let wslCached: boolean | null = null;

/** Detects WSL from environment variables without touching the filesystem. */
export function isWSLEnv(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.WSL_INTEROP || env.WSL_DISTRO_NAME || env.WSLENV);
}

/** Detects WSL2 from kernel-version markers, which also establish WSL itself. */
export function isWSL2Sync(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  try {
    const kernel = normalizeLowercaseStringOrEmpty(`${release()} ${version()}`);
    return kernel.includes("wsl2") || kernel.includes("microsoft-standard");
  } catch {
    return false;
  }
}

/** Asynchronously detects WSL from env vars and `/proc/sys/kernel/osrelease`, with process cache. */
export async function isWSL(): Promise<boolean> {
  if (wslCached !== null) {
    return wslCached;
  }
  let detected = false;
  if (process.platform === "linux") {
    detected = isWSLEnv();
    if (!detected) {
      try {
        const kernelRelease = normalizeLowercaseStringOrEmpty(
          await fs.readFile("/proc/sys/kernel/osrelease", "utf8"),
        );
        detected = kernelRelease.includes("microsoft") || kernelRelease.includes("wsl");
      } catch {
        // Missing release information leaves the environment undetected.
      }
    }
  }
  wslCached = detected;
  return detected;
}
