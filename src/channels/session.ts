// Inbound channel session recorder and last-route updater.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { InboundLastRouteUpdate, RecordInboundSession } from "./session.types.js";

// Keep session persistence lazy so channel SDK type paths do not load disk writers.
const loadInboundSessionRuntime = createLazyRuntimeModule(
  () => import("../config/sessions/inbound.runtime.js"),
);

function shouldSkipPinnedMainDmRouteUpdate(
  pin: InboundLastRouteUpdate["mainDmOwnerPin"] | undefined,
): boolean {
  if (!pin) {
    return false;
  }
  const owner = normalizeLowercaseStringOrEmpty(pin.ownerRecipient);
  const sender = normalizeLowercaseStringOrEmpty(pin.senderRecipient);
  if (!owner || !sender || owner === sender) {
    return false;
  }
  pin.onSkip?.({ ownerRecipient: pin.ownerRecipient, senderRecipient: pin.senderRecipient });
  return true;
}

export async function recordInboundSession(
  params: Parameters<RecordInboundSession>[0],
): Promise<void> {
  // Session keys may contain opaque peer ids; preserve case-sensitive payloads while normalizing shape.
  const { storePath, sessionKey, ctx, groupResolution, createIfMissing } = params;
  const canonicalSessionKey = normalizeSessionKeyPreservingOpaquePeerIds(sessionKey);
  const runtime = await loadInboundSessionRuntime();
  const write = runtime.recordInboundSessionMeta({
    storePath,
    sessionKey: canonicalSessionKey,
    ctx,
    groupResolution,
    createIfMissing,
  });
  const metaTask = write.catch(async (err: unknown) => {
    try {
      await Promise.resolve(params.onRecordError(err));
    } catch {
      // Error reporting must not reject the tracked metadata task.
    }
  });
  params.trackSessionMetaTask?.(metaTask);
  // Dispatch needs the writer settled, but best-effort reporting stays with its tracker.
  await write.catch(async (err: unknown) => {
    const { AgentDatabaseAdmissionError } = await import("../state/agent-database-admission.js");
    if (
      err instanceof AgentDatabaseAdmissionError &&
      err.refusal.code === "agent-database-inspection-pending"
    ) {
      // Leave the inbound unhandled so its channel can retry after startup admission.
      throw err;
    }
  });

  const update = params.updateLastRoute;
  if (!update) {
    return;
  }
  if (shouldSkipPinnedMainDmRouteUpdate(update.mainDmOwnerPin)) {
    return;
  }
  const targetSessionKey = normalizeSessionKeyPreservingOpaquePeerIds(update.sessionKey);
  await runtime.updateSessionLastRoute({
    storePath,
    sessionKey: targetSessionKey,
    route: update.route,
    deliveryContext: {
      channel: update.channel,
      to: update.to,
      accountId: update.accountId,
      threadId: update.threadId,
    },
    // Avoid leaking inbound origin metadata into a different target session.
    ctx: targetSessionKey === canonicalSessionKey ? ctx : undefined,
    groupResolution,
    createIfMissing,
  });
}
