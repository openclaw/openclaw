import { isTruthyEnvValue } from "../../../infra/env.js";

export const UPDATE_IN_PROGRESS_ENV = "OPENCLAW_UPDATE_IN_PROGRESS";
export const UPDATE_POST_CORE_CONVERGENCE_ENV = "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE";

/**
 * True iff the caller is the doctor pass that runs WHILE the core package
 * files are actively being swapped (e.g. inside `runGlobalPackageUpdateSteps`'
 * `postVerifyStep`). At this moment npm/pnpm machinery is busy and we must
 * NOT trigger fresh plugin installs that race with the in-flight package
 * manager activity. Configured plugin repair is deferred to the post-core
 * convergence pass.
 *
 * If post-core convergence is also set, treat the call as post-core
 * convergence (post-core wins). This lets a parent process re-enter doctor
 * with both flags set and still get repair behavior.
 */
export function isUpdatePackageSwapInProgress(env: NodeJS.ProcessEnv): boolean {
  if (isPostCoreConvergencePass(env)) {
    return false;
  }
  return isTruthyEnvValue(env[UPDATE_IN_PROGRESS_ENV]);
}

/**
 * True iff we are running the post-core convergence pass: the core package
 * swap is done, the gateway has not been restarted yet, and configured plugin
 * repair MUST run before we hand control back for the restart.
 */
export function isPostCoreConvergencePass(env: NodeJS.ProcessEnv): boolean {
  return isTruthyEnvValue(env[UPDATE_POST_CORE_CONVERGENCE_ENV]);
}
