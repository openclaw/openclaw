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

function macosVersion(): string {
  const res = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf-8" });
  const out = normalizeOptionalString(res.stdout) ?? "";
  if (out) return out;
  // Fallback: derive macOS version from Darwin kernel (os.release()).
  // Darwin 12-24 → macOS (major - 9), e.g. Darwin 24 = macOS 15
  // Darwin 25+  → formula broke (macOS 26 Tahoe uses Darwin 25, not 16)
  const release = os.release();
  const major = parseInt(release.split(".")[0], 10);
  if (!isNaN(major) && major >= 12 && major <= 24) {
    return `${major - 9}.0`;
  }
  // Darwin 25+ or unknown: return raw version labeled clearly (#95145)
  return release;
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
