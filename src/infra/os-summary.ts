// Collects operating system summary facts for diagnostics.
import { spawnSync } from "node:child_process";
import os from "node:os";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

type OsSummary = {
  platform: NodeJS.Platform;
  arch: string;
  release: string;
  label: string;
  osLabel: string;
};

const cachedOsSummaryByKey = new Map<string, OsSummary>();

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
  // On macOS the Darwin kernel release (os.release()) diverged from the macOS
  // marketing version starting with Tahoe (Darwin 25.x == macOS 26.x), so use
  // the sw_vers product version for both the diagnostics label and the runtime
  // metadata label below.
  const darwinProductVersion = platform === "darwin" ? macosVersion() : undefined;
  const label = (() => {
    if (platform === "darwin") {
      return `macos ${darwinProductVersion} (${arch})`;
    }
    if (platform === "win32") {
      return `windows ${release} (${arch})`;
    }
    return `${platform} ${release} (${arch})`;
  })();
  // Runtime prompt metadata os string. Architecture is appended separately by
  // the prompt renderer (buildRuntimeLine), so it must NOT be included here.
  // Non-darwin keeps the historical `${os.type()} ${os.release()}` shape.
  const osLabel =
    platform === "darwin" ? `macOS ${darwinProductVersion}` : `${os.type()} ${release}`;
  const summary = { platform, arch, release, label, osLabel };
  cachedOsSummaryByKey.set(cacheKey, summary);
  return summary;
}

/**
 * Resolves the OS string used in agent runtime prompt metadata, without the
 * architecture suffix. On macOS this reports the marketing product version
 * (e.g. `macOS 26.5.1`) rather than the Darwin kernel release, which is what
 * `os.release()` returns and which diverged from the product version on Tahoe.
 */
export function resolveRuntimeOsLabel(): string {
  return resolveOsSummary().osLabel;
}
