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

function macosProductVersion(): string {
  const res = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf-8" });
  const out = normalizeOptionalString(res.stdout) ?? "";
  return out || os.release();
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
      return `macos ${macosProductVersion()} (${arch})`;
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

/**
 * Resolves the OS display string used in the agent runtime prompt line.
 *
 * The returned value intentionally omits the architecture; the runtime prompt
 * renderer (`buildRuntimeLine`) appends `arch` separately. On Darwin the
 * marketing product version (e.g. `macOS 26.5.1`) is preferred over the
 * kernel release reported by `os.release()`, since the Darwin major version
 * no longer tracks the macOS major version starting with macOS 26 (Tahoe):
 * Darwin 25.x ships with macOS 26 (Tahoe), not macOS 15 (Sequoia).
 */
export function resolveRuntimePromptOs(): string {
  const platform = os.platform();
  if (platform === "darwin") {
    return `macOS ${macosProductVersion()}`;
  }
  // Non-darwin platforms keep the original Node-reported os.type()/os.release()
  // pair that agent prompts have rendered historically.
  return `${os.type()} ${os.release()}`;
}
