import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolveGatewayLaunchAgentLabel } from "./constants.js";
import { execFileUtf8 } from "./exec-file.js";

const SAFE_LABEL_PATTERN = /^[A-Za-z0-9._-]+$/;
// Stale OpenClaw update LaunchAgents are produced by `run-launchd-update-*.sh`
// handoff scripts and always carry an `.openclaw.update.<YYYYMMDD>-<HHMMSS>`
// suffix (e.g. `com.<agent>.openclaw.update.20260507-233128`). Restricting to
// that timestamped shape avoids clobbering hypothetical persistent labels like
// `com.vendor.openclaw.update.checker`.
const STALE_UPDATE_LABEL_PATTERN = /\.openclaw\.update\.\d{8}-\d{6}$/;

export type StaleLaunchdUpdateCleanupResult = {
  attempted: boolean;
  bootedOutLabels: string[];
  ignoredLabels: string[];
  warnings: string[];
};

function emptyResult(attempted: boolean): StaleLaunchdUpdateCleanupResult {
  return { attempted, bootedOutLabels: [], ignoredLabels: [], warnings: [] };
}

function resolveGuiDomain(): string {
  if (typeof process.getuid !== "function") {
    return "gui/501";
  }
  return `gui/${process.getuid()}`;
}

type ResolvedCanonicalGatewayLabel = {
  // `null` when neither override nor profile-derived fallback yields a label
  // that passes SAFE_LABEL_PATTERN. Callers must not feed null into launchctl;
  // skip the operation and surface the warnings instead.
  label: string | null;
  warnings: string[];
};

function resolveCanonicalGatewayLabel(
  env: Record<string, string | undefined>,
): ResolvedCanonicalGatewayLabel {
  const warnings: string[] = [];
  const fallback = resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
  const override = normalizeOptionalString(env.OPENCLAW_LAUNCHD_LABEL);
  if (override && !SAFE_LABEL_PATTERN.test(override)) {
    warnings.push(
      `OPENCLAW_LAUNCHD_LABEL "${sanitizeForLog(override)}" is not a valid launchd label; falling back to ${fallback}`,
    );
  }
  const candidate = override && SAFE_LABEL_PATTERN.test(override) ? override : fallback;
  if (!SAFE_LABEL_PATTERN.test(candidate)) {
    warnings.push(
      `Resolved gateway LaunchAgent label "${sanitizeForLog(candidate)}" is not a valid launchd label`,
    );
    return { label: null, warnings };
  }
  return { label: candidate, warnings };
}

function parseLaunchctlListLabels(stdout: string): string[] {
  const labels: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine) {
      continue;
    }
    // launchctl list emits TAB-separated columns: `PID<TAB>Status<TAB>Label`.
    // Splitting on whitespace would corrupt labels containing unexpected characters
    // and hide them from the safety filter, so prefer the explicit tab boundary.
    const tabFields = rawLine.split("\t");
    const raw = tabFields.length >= 3 ? (tabFields.at(-1) ?? "") : rawLine;
    const candidate = raw.trim();
    if (!candidate || candidate === "Label") {
      continue;
    }
    labels.push(candidate);
  }
  return labels;
}

async function execLaunchctl(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const isWindows = process.platform === "win32";
  const file = isWindows ? (process.env.ComSpec ?? "cmd.exe") : "launchctl";
  const fileArgs = isWindows ? ["/d", "/s", "/c", "launchctl", ...args] : args;
  return await execFileUtf8(file, fileArgs, isWindows ? { windowsHide: true } : {});
}

function isLaunchctlNotLoadedDetail(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("no such process") ||
    normalized.includes("could not find service") ||
    normalized.includes("not found")
  );
}

/**
 * Detects and boots out transient OpenClaw update LaunchAgent labels left over
 * from previous `openclaw update` runs (e.g.
 * `com.<agent>.openclaw.update.20260507-233128` from `run-launchd-update-*.sh`
 * handoff scripts). Restricted to labels matching `STALE_UPDATE_LABEL_PATTERN`
 * (timestamped `<YYYYMMDD>-<HHMMSS>` suffix) that also pass strict character
 * validation; the canonical gateway LaunchAgent is never booted out by this
 * helper.
 *
 * Failures are reported via the `warnings` field rather than thrown, so callers
 * can continue update restart/recovery even when launchctl is partially
 * unavailable.
 */
export async function cleanupStaleLaunchdUpdateJobs(args?: {
  env?: Record<string, string | undefined>;
}): Promise<StaleLaunchdUpdateCleanupResult> {
  if (process.platform !== "darwin") {
    return emptyResult(false);
  }

  const env = args?.env ?? process.env;
  const canonical = resolveCanonicalGatewayLabel(env);
  const domain = resolveGuiDomain();

  const list = await execLaunchctl(["list"]);
  if (list.code !== 0) {
    const detail = (list.stderr || list.stdout).trim() || `exit ${list.code}`;
    return {
      attempted: true,
      bootedOutLabels: [],
      ignoredLabels: [],
      warnings: [...canonical.warnings, `launchctl list failed: ${sanitizeForLog(detail)}`],
    };
  }

  const labels = parseLaunchctlListLabels(list.stdout);
  const result: StaleLaunchdUpdateCleanupResult = {
    attempted: true,
    bootedOutLabels: [],
    ignoredLabels: [],
    warnings: [...canonical.warnings],
  };

  const seen = new Set<string>();
  for (const label of labels) {
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);
    if (!STALE_UPDATE_LABEL_PATTERN.test(label)) {
      continue;
    }
    if (label === canonical.label) {
      continue;
    }
    if (!SAFE_LABEL_PATTERN.test(label)) {
      result.ignoredLabels.push(label);
      continue;
    }

    const serviceTarget = `${domain}/${label}`;
    const bootout = await execLaunchctl(["bootout", serviceTarget]);
    if (bootout.code === 0 || isLaunchctlNotLoadedDetail(bootout.stderr || bootout.stdout)) {
      result.bootedOutLabels.push(label);
      continue;
    }
    const detail = (bootout.stderr || bootout.stdout).trim() || `exit ${bootout.code}`;
    result.warnings.push(`launchctl bootout ${serviceTarget} failed: ${sanitizeForLog(detail)}`);
  }

  return result;
}

export type EnsureGatewayLaunchAgentEnabledResult = {
  attempted: boolean;
  enabled: boolean;
  warnings: string[];
};

/**
 * Re-enables the canonical gateway LaunchAgent service target. Used after the
 * update flow's stale-job cleanup so a previous `launchctl disable` (left over
 * from a transient update job) cannot block KeepAlive recovery. Failures are
 * reported via warnings rather than thrown so callers can continue.
 */
export async function ensureGatewayLaunchAgentEnabled(args?: {
  env?: Record<string, string | undefined>;
}): Promise<EnsureGatewayLaunchAgentEnabledResult> {
  if (process.platform !== "darwin") {
    return { attempted: false, enabled: false, warnings: [] };
  }

  const env = args?.env ?? process.env;
  const canonical = resolveCanonicalGatewayLabel(env);
  if (canonical.label === null) {
    return { attempted: true, enabled: false, warnings: [...canonical.warnings] };
  }
  const domain = resolveGuiDomain();
  const serviceTarget = `${domain}/${canonical.label}`;

  const result = await execLaunchctl(["enable", serviceTarget]);
  if (result.code === 0) {
    return { attempted: true, enabled: true, warnings: [...canonical.warnings] };
  }
  const detail = (result.stderr || result.stdout).trim() || `exit ${result.code}`;
  return {
    attempted: true,
    enabled: false,
    warnings: [
      ...canonical.warnings,
      `launchctl enable ${serviceTarget} failed: ${sanitizeForLog(detail)}`,
    ],
  };
}
