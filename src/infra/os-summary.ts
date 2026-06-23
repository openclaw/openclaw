// Collects operating system summary facts for diagnostics.
import { spawnSync } from "node:child_process";
import os from "node:os";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

type OsSummary = {
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  label: string;
};

const cachedOsSummaryByKey = new Map<string, OsSummary>();

let _cachedDarwinProductVersion: string | undefined;

/** Reset module-level cache (for tests). */
export function _resetCachedDarwinProductVersion(): void {
  _cachedDarwinProductVersion = undefined;
}

/**
 * Resolve Darwin product version via sw_vers.
 *
 * Darwin kernel version and macOS product version are no longer in sync starting
 * with macOS 26 (Tahoe), where Darwin 25.x maps to macOS 26.x instead of the
 * historical Darwin N → macOS N+9 formula. Prefer sw_vers over os.release() on
 * macOS to avoid stale mappings.
 *
 * Result is cached for the process lifetime — sw_vers output is stable within
 * a single OS boot. Called on the agent prompt hot path, so caching avoids a
 * synchronous subprocess spawn on every prompt build.
 */
export function resolveDarwinProductVersion(): string {
  if (_cachedDarwinProductVersion !== undefined) {
    return _cachedDarwinProductVersion;
  }
  const res = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf-8" });
  const out = normalizeOptionalString(res.stdout) ?? "";
  _cachedDarwinProductVersion = out || os.release();
  return _cachedDarwinProductVersion;
}

/**
 * Canonical OS product label for system prompts, diagnostics, and user-facing
 * display. Uses sw_vers on macOS to get the real product version instead of the
 * Darwin kernel version that diverged in Tahoe.
 */
export function resolveOsProductLabel(): string {
  const platform = os.platform();
  if (platform === "darwin") {
    return `macOS ${resolveDarwinProductVersion()}`;
  }
  if (platform === "win32") {
    return `Windows ${os.release()}`;
  }
  return `${os.type()} ${os.release()}`;
}

/** Resolves a compact OS label for diagnostics, logs, and environment summaries. */
export function resolveOsSummary(): OsSummary {
  const platform = os.platform();
  const rawRelease = os.release();
  const arch = os.arch();
  // Cache key uses raw os.release() (stable per kernel) so sw_vers drift across
  // minor macOS updates does not invalidate the cache.
  const cacheKey = `${platform}\0${rawRelease}\0${arch}`;
  const cached = cachedOsSummaryByKey.get(cacheKey);
  if (cached) {
    return cached;
  }
  const release = rawRelease;
  const label = (() => {
    if (platform === "darwin") {
      const productVersion = resolveDarwinProductVersion();
      return `macos ${productVersion} (${arch})`;
    }
    if (platform === "win32") {
      return `windows ${release} (${arch})`;
    }
    return `${platform} ${release} (${arch})`;
  })();
  const summary = { platform, arch, release, label };
  cachedOsSummaryByKey.set(cacheKey, summary);
  return summary;
}
