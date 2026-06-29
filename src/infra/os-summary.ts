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
const cachedRuntimeOsLabelByKey = new Map<string, string>();

function macosVersion(): string {
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

/**
 * Resolves the OS string used in agent runtime prompt metadata, without the
 * architecture suffix (the prompt renderer appends `arch` separately). On macOS
 * this reports the marketing product version (e.g. `macOS 26.5.1`) rather than
 * the Darwin kernel release returned by `os.release()`, which diverged from the
 * product version starting with Tahoe (Darwin 25.x == macOS 26.x). Off Darwin it
 * keeps the historical `${os.type()} ${os.release()}` shape verbatim.
 *
 * Kept separate from {@link resolveOsSummary} so this prompt-only label is not
 * serialized into status JSON or trajectory metadata, which emit the summary
 * object wholesale.
 */
export function resolveRuntimeOsLabel(): string {
  const platform = os.platform();
  const release = os.release();
  const arch = os.arch();
  const cacheKey = `${platform}\0${release}\0${arch}`;
  const cached = cachedRuntimeOsLabelByKey.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const osLabel = platform === "darwin" ? `macOS ${macosVersion()}` : `${os.type()} ${release}`;
  cachedRuntimeOsLabelByKey.set(cacheKey, osLabel);
  return osLabel;
}
