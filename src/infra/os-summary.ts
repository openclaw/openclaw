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

function darwinToMacOS(release: string): string {
  const dot = release.indexOf(".");
  const major = dot > 0 ? Number(release.slice(0, dot)) : Number(release);
  if (!Number.isFinite(major) || major <= 0) {
    return release;
  }
  // Known kernel ↔ macOS mappings:
  //   Darwin 24 → macOS 15 (Sequoia)
  //   Darwin 25 → macOS 26 (Tahoe)
  // For earlier releases the linear offset darwinMajor - 9 holds
  // (Darwin 20 → macOS 11 through Darwin 23 → macOS 14).
  const suffix = dot > 0 ? release.slice(dot) : "";
  if (major === 25) {
    return `26${suffix}`;
  }
  if (major === 24) {
    return `15${suffix}`;
  }
  if (major >= 20 && major <= 23) {
    return `${major - 9}${suffix}`;
  }
  return release;
}

function macosVersion(): string {
  const res = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf-8" });
  const out = normalizeOptionalString(res.stdout) ?? "";
  return out || darwinToMacOS(os.release());
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
  const summary = { platform, arch, release, label };
  cachedOsSummaryByKey.set(cacheKey, summary);
  return summary;
}
