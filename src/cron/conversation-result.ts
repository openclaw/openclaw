import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { commitBackgroundResultToSession } from "../sessions/background-session-result.js";
import type { CronCompletionDeliveryFence } from "./delivery-attempt-fence.js";
import { createCronRunDiagnosticsFromError } from "./run-diagnostics.js";
import { createCronExecutionId } from "./run-id.js";
import type { CronRunDiagnostics } from "./types.js";

/** Internal-channel completion only; external deliveries are owned by outbound. */
export async function commitCronConversationResult(params: {
  config: OpenClawConfig;
  agentId: string;
  jobId: string;
  runStartedAt: number;
  conversation: { sessionKey: string; sessionId: string; lifecycleRevision?: string };
  payloads: ReplyPayload[];
  text?: string;
  signal?: AbortSignal;
  deliveryAttemptFence: CronCompletionDeliveryFence | null;
}): Promise<{ ok: true; diagnostics?: CronRunDiagnostics } | { ok: false; reason: string }> {
  const runId = createCronExecutionId(params.jobId, params.runStartedAt);
  await params.deliveryAttemptFence?.beforeAttempt();
  const committed = await commitBackgroundResultToSession({
    ...params,
    sessionKey: params.conversation.sessionKey,
    expectedGeneration: {
      sessionId: params.conversation.sessionId,
      lifecycleRevision: params.conversation.lifecycleRevision,
    },
    idempotencyKey: `cron-current-completion:${runId}`,
    provenance: { kind: "cron", jobId: params.jobId, runId },
    assertCurrent: () => {
      params.signal?.throwIfAborted();
      params.deliveryAttemptFence?.assertCurrent();
    },
  });
  if (!committed.ok) {
    return committed;
  }
  return {
    ok: true,
    ...(committed.diagnostics
      ? {
          diagnostics: createCronRunDiagnosticsFromError("delivery", committed.diagnostics, {
            severity: "warn",
          }),
        }
      : {}),
  };
}
