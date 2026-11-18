import type { createHeadlessDeadlineScope } from "../agents/code-mode-headless.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { GitHubPublicationReadUnavailableError } from "../gateway/github-publication-json-read.js";
import {
  SESSION_PR_AUTO_FIX_TRIGGER,
  sessionPrAutoFixTarget,
} from "../shared/session-pr-auto-fix.js";
import type { CronJob } from "./types.js";

export function prAutoFixFailureCode(params: { job: CronJob; script: string }, error: unknown) {
  return error instanceof GitHubPublicationReadUnavailableError &&
    params.script === SESSION_PR_AUTO_FIX_TRIGGER &&
    sessionPrAutoFixTarget(params.job)
    ? "runtime_unavailable"
    : "internal_error";
}

/** Native observation uses the same admitted caller, cancellation, and deadline as its condition. */
export async function observePrAutoFix(
  params: { job: CronJob; script: string; state: unknown },
  caller: Parameters<typeof withGatewayToolCallerIdentity>[0],
  scope: ReturnType<typeof createHeadlessDeadlineScope>,
  assertCurrent: () => void,
) {
  if (params.script !== SESSION_PR_AUTO_FIX_TRIGGER || !sessionPrAutoFixTarget(params.job)) {
    return params.state;
  }
  const { readSessionPrAutoFixObservation } =
    await import("../gateway/github-publication-auto-fix.js");
  const observation = await scope.wait(
    withGatewayToolCallerIdentity(caller, () =>
      readSessionPrAutoFixObservation({ job: params.job, assertCurrent }),
    ),
  );
  assertCurrent();
  return { previous: params.state, observation };
}
