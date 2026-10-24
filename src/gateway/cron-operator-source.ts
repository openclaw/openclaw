import { isDeepStrictEqual } from "node:util";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { captureCronJobSourceAuthority } from "../cron/active-jobs.js";
import type { CronCompletionDeliveryFence } from "../cron/delivery-attempt-fence.js";
import { CronOperatorSourceError } from "../cron/operator-source-error.js";
import { resolveCronOperatorExecutionRevision } from "../cron/service/jobs-tool-policy.js";
import type { CronStoredJob } from "../cron/types.js";
import { isAbortError } from "../infra/abort-signal.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { decodeGatewayOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { restoreGatewayOperatorSource } from "./operator-run-recovery.js";

/** Re-admit a captured same-conversation source, never a session owner or ambient scheduler. */
export async function restoreCronOperatorSource(params: {
  job: CronStoredJob;
  agentId: string;
  sessionKey: string;
  entry: Pick<InternalSessionEntry, "sessionId" | "lifecycleRevision">;
  signal?: AbortSignal;
  deliveryAttemptFence: CronCompletionDeliveryFence | null;
}) {
  if (!params.job.operatorSource) {
    return undefined;
  }
  let operator: Awaited<ReturnType<typeof restoreGatewayOperatorSource>> | undefined;
  try {
    const captured = params.job.operatorSource;
    const source = decodeGatewayOperatorRecoverySource(captured.source);
    const context = getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext?.();
    const assertOccurrence = captureCronJobSourceAuthority(params.job.id);
    if (!context || !assertOccurrence || !params.deliveryAttemptFence) {
      throw new Error("Scheduled operator continuation requires its live Gateway occurrence");
    }
    const fence = params.deliveryAttemptFence;
    let admitted = false;
    const assertCurrent = () => {
      params.signal?.throwIfAborted();
      // Admission may force-run an already paused job; later disable/remove edits
      // revoke this exact occurrence through its existing cancellation owner.
      assertOccurrence();
      fence.assertCurrent();
      if (admitted) {
        return;
      }
      const current: CronStoredJob | undefined = context.cron.getJob(params.job.id);
      const policy = current?.scheduledToolPolicy;
      if (
        context.resolveGatewayContext?.() !== context ||
        !current ||
        current.operatorSource?.executionRevision !==
          resolveCronOperatorExecutionRevision(current) ||
        current.payload.kind !== "agentTurn" ||
        policy?.mode !== "account" ||
        policy.ownerSessionKey !== source.sessionKey ||
        current.owner?.sessionKey !== source.sessionKey ||
        current.sessionTarget !== `session:${source.sessionKey}` ||
        params.agentId !== source.agentId ||
        params.sessionKey !== source.sessionKey ||
        params.entry.sessionId !== source.sessionId ||
        params.entry.lifecycleRevision !== source.lifecycleRevision ||
        !isDeepStrictEqual(current.operatorSource, captured)
      ) {
        throw new Error(
          "Scheduled operator continuation definition or conversation changed; recreate it from an authenticated turn",
        );
      }
    };
    assertCurrent();
    operator = await restoreGatewayOperatorSource({
      snapshot: source.snapshot,
      target: source,
      context,
      assertCurrent,
    });
    assertCurrent();
    admitted = true;
    return operator;
  } catch (error) {
    operator?.release();
    // Restart and cancellation end this attempt; they say nothing about the stored source.
    if (params.signal?.aborted || isAbortError(error)) {
      throw error;
    }
    throw new CronOperatorSourceError(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}
