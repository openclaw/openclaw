import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
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

export async function deliverPendingDeliveryNotice(
  sessionKey: string,
  storePath: string,
): Promise<void> {
  const source = captureIncognitoSessionSource({ sessionKey, storePath });
  if (source) {
    if ("kind" in source) {
      return;
    }
    return source.actor.sessions.withSharedState(async () => {
      const read = await source.actor.sessions.read(
        { assertCurrent: () => source.actor.assertCurrent() },
        { sessionKey },
        source.admissionSignal,
      );
      read.snapshot.assertCurrent();
      const claim = source.actor.sessions.captureCurrent(sessionKey);
      return deliverNotice(
        sessionKey,
        storePath,
        read.entry,
        () => {
          source.admissionSignal?.throwIfAborted();
          claim.assertCurrent();
          const current = source.actor.sessions.readDelivery(sessionKey);
          if (
            deliveryContextKey(deliveryContextFromSession(current)) !==
            deliveryContextKey(deliveryContextFromSession(read.entry))
          ) {
            throw new Error("Pending delivery notice route changed before delivery");
          }
        },
        true,
      );
    });
  }
  const entry = loadSessionEntryReadOnly({
    sessionKey,
    storePath,
    readConsistency: "latest",
    hydrateSkillPromptRefs: false,
  });
  return deliverNotice(sessionKey, storePath, entry);
}

async function deliverNotice(
  sessionKey: string,
  storePath: string,
  entry: SessionEntry | undefined,
  assertCurrent: () => void = () => {},
  liveOnly = false,
): Promise<void> {
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
  const idempotencyKey = `main-session-restart-recovery:pending-final:${notice.intentId}`;
  let delivered: boolean;
  try {
    assertCurrent();
    const request = {
      channel: context.channel,
      to: context.to,
      accountId: context.accountId,
      threadId: context.threadId,
      text: PENDING_DELIVERY_NOTICE,
      idempotencyKey,
    };
    const outcome = await runtime.sendRecoveryNotice(
      liveOnly
        ? {
            ...request,
            liveOnly: true,
            isCurrent: () => {
              assertCurrent();
              return true;
            },
          }
        : request,
    );
    delivered = !outcome.suppressed;
  } catch {
    assertCurrent();
    const owner = await findDeliveryIntentOwner(idempotencyKey);
    if (owner?.status !== "completed" && owner?.status !== "failed") {
      return;
    }
    delivered = owner.status === "completed";
  }
  assertCurrent();
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
  await patchSessionEntryCore(
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
    {
      skipMaintenance: true,
      takeCacheOwnership: true,
      ...(liveOnly ? { assertCommitAllowed: assertCurrent } : {}),
    },
  );
}
