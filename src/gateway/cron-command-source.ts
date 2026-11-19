import { runCronCommandJob } from "../cron/command-runner.js";
import type { CronStoredJob } from "../cron/types.js";
import { restoreCronOperatorSource } from "./cron-operator-source.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** Runs a stored command only while the authenticated source that created it stays current. */
export async function runCronCommandUnderSource(
  params: {
    job: CronStoredJob;
    abortSignal?: AbortSignal;
    deliveryAttemptFence: Parameters<typeof restoreCronOperatorSource>[0]["deliveryAttemptFence"];
  },
  resolveGatewayContext: (() => GatewayRequestContext | undefined) | undefined,
) {
  // Jobs without a stored source keep their existing profile/legacy execution path.
  const operator = await restoreCronOperatorSource({
    job: params.job,
    context: resolveGatewayContext?.(),
    signal: params.abortSignal,
    deliveryAttemptFence: params.deliveryAttemptFence,
  });
  try {
    operator?.authority.assertCurrent();
    const revoked = operator?.authority.signal;
    // Revocation reaches the runner's existing pre-spawn check and process-tree cancellation.
    const abortSignal =
      revoked && params.abortSignal
        ? AbortSignal.any([params.abortSignal, revoked])
        : (revoked ?? params.abortSignal);
    return await runCronCommandJob({ job: params.job, abortSignal, nowMs: Date.now });
  } finally {
    operator?.release();
  }
}
