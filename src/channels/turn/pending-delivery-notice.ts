import { updateSessionEntry } from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions/transcript.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getGatewayRecoveryRuntime } from "../../gateway/server-recovery-runtime-context.js";
import { findDeliveryIntentOwner } from "../../infra/outbound/delivery-queue-storage.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.read.js";
import {
  deliveryContextKey,
  normalizeDeliveryContext,
} from "../../utils/delivery-context.shared.js";

const PENDING_DELIVERY_NOTICE =
  "I couldn’t confirm whether my previous reply reached this chat, so I won’t resend it automatically. Please ask for any missing remainder.";

/**
 * A queued final settles its custody "unknown" (and owes this notice) before
 * platform I/O starts, so a crash mid-send cannot lose the debt. While the
 * durable queue still owns that send, the outcome is pending rather than lost:
 * settlement clears the notice on delivery or affirms it on failure.
 * Announcing inside that window reports a reply as unconfirmed while it is
 * still on its way (openclaw/openclaw#154416). That race is over in roughly
 * the time one platform round trip takes, so only pay for the extra queue
 * lookup while the pending final is still that fresh; an older one has long
 * since settled one way or another, and querying it for every stale notice
 * adds needless durable-queue I/O to the common case.
 */
const STILL_QUEUED_CHECK_MAX_AGE_MS = 60_000;

async function isNoticedFinalStillQueued(entry: SessionEntry, intentId: string): Promise<boolean> {
  const pending = entry.pendingFinalDelivery;
  if (
    pending?.intentId !== intentId ||
    Date.now() - pending.createdAt > STILL_QUEUED_CHECK_MAX_AGE_MS
  ) {
    return false;
  }
  for (const delivery of pending.deliveries ?? []) {
    if (delivery.state === "delivered" || delivery.state === "suppressed") {
      continue;
    }
    // Channel sends enqueue a pending final under its delivery id. The queue
    // lookup is unavailable for direct, non-durable custody; treat that as
    // "not queued" rather than letting the lookup failure block the notice.
    let owner: Awaited<ReturnType<typeof findDeliveryIntentOwner>> | undefined;
    try {
      owner = await findDeliveryIntentOwner(delivery.id);
    } catch {
      continue;
    }
    if (owner?.status === "pending" || owner?.settlementPending === true) {
      return true;
    }
  }
  return false;
}

/**
 * On a channel/account where platform delivery confirmation is structurally
 * unreliable, every turn can land its own fresh "unknown" settlement and owe
 * its own notice, which turns a once-per-restart courtesy message into a
 * standing failure mode that silently replaces real replies turn after turn
 * (openclaw/openclaw#162554). Past this age, stop re-announcing and let the
 * debt lapse unresolved instead of indefinitely contesting the current turn's
 * real answer.
 */
const PENDING_DELIVERY_NOTICE_MAX_AGE_MS = 10 * 60 * 1000;

export async function deliverPendingDeliveryNotice(
  sessionKey: string,
  storePath: string,
): Promise<void> {
  const entry = await readSessionEntryReadOnlyInWorker({
    sessionKey,
    storePath,
    readConsistency: "latest",
    hydrateSkillPromptRefs: false,
  });
  const notice = entry?.pendingDeliveryNotice;
  const context = normalizeDeliveryContext(notice?.context);
  const runtime = getGatewayRecoveryRuntime();
  if (
    !entry ||
    !runtime ||
    !notice ||
    notice.state !== "owed" ||
    !context?.channel ||
    !context.to ||
    deliveryContextKey(context) !== deliveryContextKey(deliveryContextFromSession(entry))
  ) {
    return;
  }
  if (await isNoticedFinalStillQueued(entry, notice.intentId)) {
    // Leave the debt owed; the queue's settlement decides whether it is announced.
    return;
  }
  if (Date.now() - notice.createdAt > PENDING_DELIVERY_NOTICE_MAX_AGE_MS) {
    // Too stale to usefully announce, and leaving it "owed" would keep contesting
    // every subsequent turn's own reply on a structurally ambiguous channel.
    await updateSessionEntry(
      { sessionKey, storePath },
      (current) =>
        current.sessionId === entry.sessionId &&
        current.pendingDeliveryNotice?.intentId === notice.intentId &&
        current.pendingDeliveryNotice.state === "owed"
          ? { pendingDeliveryNotice: { ...current.pendingDeliveryNotice, state: "unresolved" } }
          : null,
      { skipMaintenance: true, takeCacheOwnership: true },
    );
    return;
  }
  const idempotencyKey = `main-session-restart-recovery:pending-final:${notice.intentId}`;
  let delivered: boolean;
  try {
    const outcome = await runtime.sendRecoveryNotice({
      channel: context.channel,
      to: context.to,
      accountId: context.accountId,
      threadId: context.threadId,
      text: PENDING_DELIVERY_NOTICE,
      idempotencyKey,
    });
    delivered = !outcome.suppressed;
  } catch {
    const owner = await findDeliveryIntentOwner(idempotencyKey);
    if (owner?.status !== "completed" && owner?.status !== "failed") {
      return;
    }
    delivered = owner.status === "completed";
  }
  if (
    delivered &&
    !(
      await appendAssistantMessageToSessionTranscript({
        sessionKey,
        storePath,
        expectedSessionId: entry.sessionId,
        text: PENDING_DELIVERY_NOTICE,
        idempotencyKey,
      })
    ).ok
  ) {
    return;
  }
  await updateSessionEntry(
    { sessionKey, storePath },
    (current) =>
      current.sessionId === entry.sessionId &&
      current.pendingDeliveryNotice?.intentId === notice.intentId &&
      current.pendingDeliveryNotice.state !== "acknowledged"
        ? {
            // Retain the terminal fact: queue settlement may replay after this
            // acknowledgment, and one intent must never owe its notice again.
            pendingDeliveryNotice: {
              ...current.pendingDeliveryNotice,
              state: delivered ? "acknowledged" : "unresolved",
            },
            updatedAt: Date.now(),
          }
        : null,
    { skipMaintenance: true, takeCacheOwnership: true },
  );
}
