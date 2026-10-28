import { assert } from "vitest";
import type { RecoveryNoticeProvenance } from "../config/sessions/recovery-notice.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";

export const recoveryNoticeText = "The interrupted turn could not resume. Use Resume in WebChat.";
export const savedRecoveryReply = "Unconfirmed private draft: do not replay this content.";
export const recoveryNoticeDestination = {
  channel: "reef",
  to: "reef:notice-recipient",
  accountId: "default",
  threadId: 42,
};

/** Seeds the immutable local notice and its captured owner; transport acceptance is separate. */
export async function createRecoveryNoticeFixture(
  storePath: string,
  localNotice = true,
  destination: {
    channel: string;
    to: string;
    accountId?: string;
    threadId?: string | number;
  } = recoveryNoticeDestination,
) {
  const generation = {
    agentId: "secondary",
    storePath,
    sessionKey: "agent:secondary:dashboard:recovery",
    sessionId: "recovery-session",
    lifecycleRevision: "recovery-lifecycle",
  };
  const recovery = {
    cycleId: "recovery-cycle",
    revision: 4,
    chargedAttempts: 3,
    tombstone: { reason: "recovery exhausted" },
  };
  const entry = {
    sessionId: generation.sessionId,
    lifecycleRevision: generation.lifecycleRevision,
    updatedAt: 1,
    delivery: normalizeSessionDeliveryState({ context: destination }),
    ...(localNotice ? { mainRestartRecovery: recovery } : {}),
  };
  await replaceSessionEntry(generation, entry);
  const provenance: RecoveryNoticeProvenance = {
    kind: "recovery-notice",
    noticeId: "recovery-notice",
  };
  if (localNotice) {
    const appended = await appendAssistantMessageToSessionTranscript({
      ...generation,
      expectedSessionId: generation.sessionId,
      expectedLifecycleRevision: generation.lifecycleRevision,
      idempotencyKey: provenance.noticeId,
      content: [
        { type: "text", text: recoveryNoticeText },
        { type: "text", text: `\nSaved reply (delivery unconfirmed):\n${savedRecoveryReply}` },
      ],
      deliveryMirror: {
        kind: "restart-recovery-notice",
        noticeId: provenance.noticeId,
        cycleId: recovery.cycleId,
        revision: recovery.revision,
        noticePart: 0,
        destination,
      },
    });
    assert(appended.ok && appended.anchor);
    const {
      generation: transcriptGeneration,
      entryId,
      rawSeq,
      effectiveParentId,
      activeMessagePosition,
    } = appended.anchor;
    provenance.localNotice = {
      generation: transcriptGeneration,
      entryId,
      rawSeq,
      effectiveParentId,
      activeMessagePosition,
    };
  }
  return {
    generation,
    entry,
    provenance,
    producer: {
      agentId: generation.agentId,
      policyKey: generation.sessionKey,
    },
  };
}
