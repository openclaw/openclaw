import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { commitBackgroundPayloadsToSession } from "../sessions/background-result-payloads.js";
import type { CronCompletionDeliveryFence } from "./delivery-attempt-fence.js";
import { createCronRunDiagnosticsFromError } from "./run-diagnostics.js";
import { createCronExecutionId } from "./run-id.js";
import type { CronRunDiagnostics } from "./types.js";

export type CronConversationResultParams = {
  config: OpenClawConfig;
  agentId: string;
  jobId: string;
  runStartedAt: number;
  conversation: { sessionKey: string; sessionId: string; lifecycleRevision?: string };
  payloads: ReplyPayload[];
  signal?: AbortSignal;
  deliveryAttemptFence: CronCompletionDeliveryFence | null;
};

/** Commits an internal-channel result; external deliveries are recorded by outbound delivery. */
export async function commitCronConversationResult(
  params: CronConversationResultParams,
): Promise<{ ok: true; diagnostics?: CronRunDiagnostics } | { ok: false; reason: string }> {
  const runId = createCronExecutionId(params.jobId, params.runStartedAt);
  await params.deliveryAttemptFence?.beforeAttempt();
  const committed = await commitBackgroundPayloadsToSession({
    agentId: params.agentId,
    sessionKey: params.conversation.sessionKey,
    expectedGeneration: {
      sessionId: params.conversation.sessionId,
      lifecycleRevision: params.conversation.lifecycleRevision,
    },
    payloads: params.payloads,
    idempotencyKey: `cron-current-completion:${runId}`,
    provenance: { kind: "cron", jobId: params.jobId, runId },
    config: params.config,
    signal: params.signal,
    assertCurrent: () => {
      params.signal?.throwIfAborted();
      params.deliveryAttemptFence?.assertCurrent();
    },
  });
  if (!committed.ok) {
    return committed;
  }
  return committed.diagnostics
    ? {
        ok: true,
        diagnostics: createCronRunDiagnosticsFromError("delivery", committed.diagnostics, {
          severity: "warn",
        }),
      }
    : { ok: true };
}
