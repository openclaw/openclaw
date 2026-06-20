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

let cachedMacosVersion: string | undefined;

/** @internal Reset internal caches (for tests only). */
export function _resetOsSummaryCaches(): void {
  cachedMacosVersion = undefined;
  cachedOsSummaryByKey.clear();
}

function macosVersion(): string {
  if (cachedMacosVersion !== undefined) {
    return cachedMacosVersion;
  }
  const res = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf-8" });
  const out = normalizeOptionalString(res.stdout) ?? "";
  cachedMacosVersion = out || os.release();
  return cachedMacosVersion;
}

/** Returns the OS release string. On macOS, prefers the marketing version
 *  from `sw_vers -productVersion` (e.g. "26.5.1") over the Darwin kernel
 *  version from `os.release()` (e.g. "25.5.0"), which diverged starting
 *  with macOS 26 (Tahoe / Darwin 25). On other platforms, returns
 *  `os.release()` unchanged. */
export function resolveOsRelease(): string {
  if (os.platform() === "darwin") {
    return macosVersion();
  }
  return os.release();
}

/** Returns a human-readable runtime OS label. On macOS, uses the marketing
 *  version from `sw_vers -productVersion` (e.g. "macos 26.5.1") instead of
 *  the raw Darwin kernel version (e.g. "Darwin 25.5.0"). On other platforms,
 *  returns `os.type()` plus `os.release()` unchanged. */
export function resolveRuntimeOsLabel(): string {
  if (os.platform() === "darwin") {
    return `macos ${macosVersion()}`;
  }
  return `${os.type()} ${os.release()}`;
}

/** Resolves a compact OS label for diagnostics, logs, and environment summaries. */
export function resolveOsSummary(): OsSummary {
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  const cacheKey = `${platform}\0${release}\0${arch}`;
  // Cache by stable os.* facts; darwin's sw_vers lookup is comparatively slow
  // and only needed once per observed platform/release/arch tuple.
  const cached = cachedOsSummaryByKey.get(cacheKey);
  if (cached) {
    return cached;
  }
  const label = (() => {
    if (platform === "darwin") {
      return `macos ${macosVersion()} (${arch})`;
    }
    if (platform === "win32") {
      return `windows ${release} (${arch})`;
    }
    return `${platform} ${release} (${arch})`;
  })();
  const summary = { platform, arch, release: resolveOsRelease(), label };
  cachedOsSummaryByKey.set(cacheKey, summary);
  return summary;
}
