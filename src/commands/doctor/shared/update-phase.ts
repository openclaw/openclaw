// Update-phase helpers that gate doctor repairs during package swaps and convergence.
import { isTruthyEnvValue } from "../../../infra/env.js";
import { VERSION } from "../../../version.js";

export const UPDATE_IN_PROGRESS_ENV = "OPENCLAW_UPDATE_IN_PROGRESS";
/** Managed updaters must opt in to NOCOW rewrites, which change physical store identities. */
export const DOCTOR_SQLITE_NOCOW_REPAIR_ENV = "OPENCLAW_DOCTOR_SQLITE_NOCOW_REPAIR";
export const UPDATE_POST_CORE_CONVERGENCE_ENV = "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE";
export const UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV =
  "OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR";
export const UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV =
  "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE";
export const UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION_ENV =
  "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION";

/** Share the post-swap discovery context through planning and final publication. */
export function resolvePostCoreConvergenceEnv(
  env: NodeJS.ProcessEnv | undefined,
  compatibilityHostVersion?: string,
): NodeJS.ProcessEnv {
  return {
    ...env,
    OPENCLAW_COMPATIBILITY_HOST_VERSION: compatibilityHostVersion ?? VERSION,
    [UPDATE_POST_CORE_CONVERGENCE_ENV]: "1",
  };
}

function isExplicitOptOutEnvValue(value: string | undefined): boolean {
  // Update handoff predates canonical opt-in flags: every non-false value means the
  // parent opted in, so preserve its broad acceptance until that protocol is retired.
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

export function shouldSkipLegacyUpdateDoctorConfigWrite(env: NodeJS.ProcessEnv): boolean {
  return (
    isExplicitOptOutEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS) &&
    !isExplicitOptOutEnvValue(env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV])
  );
}

/** Shipped canaries clear IN_PROGRESS for lint but retain the writable-parent marker. */
export function isUpdateDoctorLintPass(env: NodeJS.ProcessEnv): boolean {
  return (
    isTruthyEnvValue(env[UPDATE_IN_PROGRESS_ENV]) ||
    isPostCoreConvergencePass(env) ||
    isTruthyEnvValue(env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV])
  );
}

/** Package swaps defer plugin installation to avoid racing the package manager.
 * Post-core convergence wins when both markers are present. Direct IN_PROGRESS
 * readers intentionally retain warning/check suppression during convergence;
 * only move them here when they need to distinguish those phases. */
export function isUpdatePackageSwapInProgress(env: NodeJS.ProcessEnv): boolean {
  return !isPostCoreConvergencePass(env) && isTruthyEnvValue(env[UPDATE_IN_PROGRESS_ENV]);
}

/**
 * True iff configured plugin install repair should be deferred because the
 * updater guarantees a later post-core convergence pass. Older shipped
 * parents may set only the writable-config marker. Those parents still have a
 * post-core handoff, but their in-memory install records are stale after the
 * candidate doctor exits, so defer payload repair to the updated child process.
 */
export function shouldDeferConfiguredPluginInstallRepair(env: NodeJS.ProcessEnv): boolean {
  return (
    isUpdatePackageSwapInProgress(env) &&
    (isTruthyEnvValue(env[UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]) ||
      isTruthyEnvValue(env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]))
  );
}

/**
 * True iff a new doctor is running inside a shipped parent that can persist
 * doctor config repairs. Config writes must stay old-parent-readable because
 * that parent resumes after the candidate doctor exits. Modern parents also
 * set the explicit deferral marker, so they should keep current metadata
 * writes while still deferring payload repair.
 */
export function isLegacyParentWritableUpdateDoctorPass(env: NodeJS.ProcessEnv): boolean {
  return (
    isUpdatePackageSwapInProgress(env) &&
    isTruthyEnvValue(env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]) &&
    !isTruthyEnvValue(env[UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV])
  );
}

/**
 * True iff we are running the post-core convergence pass: the core package
 * swap is done, the gateway has not been restarted yet, and configured plugin
 * repair MUST run before we hand control back for the restart.
 */
export function isPostCoreConvergencePass(env: NodeJS.ProcessEnv): boolean {
  return isTruthyEnvValue(env[UPDATE_POST_CORE_CONVERGENCE_ENV]);
}
