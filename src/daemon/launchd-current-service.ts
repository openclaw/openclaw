/** Detects native launchd membership, including children reparented after ancestor exit. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getSelfAndAncestorPidsSync } from "../infra/restart-stale-pids.js";
import { probeLaunchAgentState, resolveLaunchAgentGuiDomain } from "./launchd-runtime.js";
import { ServiceInspectionError } from "./service-inspection-error.js";
import { inspectServiceProcessMembershipSync } from "./service-process-membership.js";

function hasNativeLaunchdServiceLabel(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return [env.LAUNCH_JOB_LABEL, env.LAUNCH_JOB_NAME, env.XPC_SERVICE_NAME].some(
    (value) => normalizeOptionalString(value) === label,
  );
}

/** Environment hints for launchd identity; inherited markers do not prove ancestry. */
export function isCurrentProcessLaunchdServiceLabel(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return hasNativeLaunchdServiceLabel(label, env) || hasOpenClawServiceMarker(label, env);
}

function hasOpenClawServiceMarker(label: string, env: NodeJS.ProcessEnv): boolean {
  // Detached update/restart handoffs keep OPENCLAW_LAUNCHD_LABEL as the service
  // identity to manage while running outside the job, so the configured label
  // alone never proves membership: a restart that trusted it would schedule a
  // detached handoff instead of restarting and health-proving the service.
  // Managed wrappers inject the service marker; trust it when launchd's own
  // label variables are absent or renamed by the host environment.
  return (
    normalizeOptionalString(env.OPENCLAW_LAUNCHD_LABEL) === label &&
    normalizeOptionalString(env.OPENCLAW_SERVICE_MARKER) === "openclaw" &&
    Boolean(normalizeOptionalString(env.OPENCLAW_SERVICE_KIND))
  );
}

/** A completed parent walk alone cannot exclude reparented members of a launchd job. */
export async function isCurrentProcessInsideLaunchdService(label: string): Promise<boolean> {
  const probe = await probeLaunchAgentState(`${resolveLaunchAgentGuiDomain()}/${label}`);
  if (probe.state === "running" && probe.runtime.pid !== undefined) {
    const ancestors = getSelfAndAncestorPidsSync();
    if (ancestors.has(probe.runtime.pid)) {
      return true;
    }
    const membership = inspectServiceProcessMembershipSync(probe.runtime.pid, "darwin");
    if (membership === "inside") {
      return true;
    }
    if (membership === "unknown") {
      throw new ServiceInspectionError("service-membership-unverified");
    }
    if (!ancestors.has(1)) {
      throw new ServiceInspectionError("service-ancestry-unverified");
    }
    return false;
  }
  if (probe.state === "unknown" || probe.state === "running") {
    throw new ServiceInspectionError("service-membership-unverified");
  }
  return false;
}
