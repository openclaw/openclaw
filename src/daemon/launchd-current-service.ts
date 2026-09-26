/** Detects launchd service membership from environment markers or process ancestry. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getSelfAndAncestorPidsSync } from "../infra/restart-stale-pids.js";
import { probeLaunchAgentState, resolveLaunchAgentGuiDomain } from "./launchd-runtime.js";

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

/**
 * Native launchd labels are the fast path. OpenClaw markers can outlive the job
 * in an external terminal, so reconcile them with the running job's ancestry.
 * The detached update helper's recovery CLI inherits OPENCLAW_LAUNCHD_LABEL but
 * descends from no running Gateway, so it stays on the synchronous path.
 */
export async function isCurrentProcessInsideLaunchdService(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (hasNativeLaunchdServiceLabel(label, env)) {
    return true;
  }
  // Preserve the in-service guard when launchd cannot supply authoritative facts.
  const probe = await probeLaunchAgentState(`${resolveLaunchAgentGuiDomain()}/${label}`);
  if (probe.state === "running" && probe.runtime.pid !== undefined) {
    const ancestors = getSelfAndAncestorPidsSync();
    // The ancestor walk is best-effort. Only reaching launchd (PID 1) proves
    // an external shell; a failed ps hop must not disable the in-service guard.
    return (
      ancestors.has(probe.runtime.pid) ||
      (hasOpenClawServiceMarker(label, env) && !ancestors.has(1))
    );
  }
  return (
    (probe.state === "unknown" || probe.state === "running") && hasOpenClawServiceMarker(label, env)
  );
}
