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

/**
 * Cache for the slow Darwin `sw_vers -productVersion` lookup, keyed by
 * `os.release()` (the kernel release a given binary is observing). Once
 * resolved for a given kernel release, the macOS marketing product version
 * is stable for the lifetime of the process — there is no scenario where
 * macOS changes its product version without the kernel release changing
 * too — so re-spawning `sw_vers` per call only burns latency on every
 * runtime prompt build (#95145 review feedback on PR #95189).
 */
const cachedMacosProductVersionByRelease = new Map<string, string>();

function macosProductVersion(): string {
  const release = os.release();
  const cached = cachedMacosProductVersionByRelease.get(release);
  if (cached !== undefined) {
    return cached;
  }
  const res = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf-8" });
  const out = normalizeOptionalString(res.stdout) ?? "";
  const resolved = out || release;
  cachedMacosProductVersionByRelease.set(release, resolved);
  return resolved;
}

/**
 * Test-only: clear both module-level caches so each test case can mock a
 * different `os.release()` without leaking the previous case's resolved
 * Darwin marketing version. Not part of the public API — prefer keying tests
 * by unique kernel releases when possible.
 */
export function __resetOsSummaryCachesForTests(): void {
  cachedOsSummaryByKey.clear();
  cachedMacosProductVersionByRelease.clear();
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
