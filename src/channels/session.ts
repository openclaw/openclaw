import type { MsgContext } from "../auto-reply/templating.js";
import type { GroupKeyResolution } from "../config/sessions/types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { InboundLastRouteUpdate } from "./session.types.js";
export type { InboundLastRouteUpdate, RecordInboundSession } from "./session.types.js";

let inboundSessionRuntimePromise: Promise<
  typeof import("../config/sessions/inbound.runtime.js")
> | null = null;

function loadInboundSessionRuntime() {
  inboundSessionRuntimePromise ??= import("../config/sessions/inbound.runtime.js");
  return inboundSessionRuntimePromise;
}

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

export async function recordInboundSession(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
  updateLastRoute?: InboundLastRouteUpdate;
  onRecordError: (err: unknown) => void;
  trackSessionMetaTask?: (task: Promise<unknown>) => void;
}): Promise<void> {
  const { storePath, sessionKey, ctx, groupResolution, createIfMissing } = params;
  const canonicalSessionKey = normalizeLowercaseStringOrEmpty(sessionKey);
  const runtime = await loadInboundSessionRuntime();
  const metaTask = runtime
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: canonicalSessionKey,
      ctx,
      groupResolution,
      createIfMissing,
    })
    .catch(params.onRecordError);
  params.trackSessionMetaTask?.(metaTask);
  void metaTask;

  const resolvedUpdate: InboundLastRouteUpdate | undefined =
    params.updateLastRoute ??
    (() => {
      const channel =
        typeof params.ctx.OriginatingChannel === "string"
          ? params.ctx.OriginatingChannel.trim()
          : typeof params.ctx.Provider === "string"
            ? params.ctx.Provider.trim()
            : typeof params.ctx.Surface === "string"
              ? params.ctx.Surface.trim()
              : "";
      const to =
        typeof params.ctx.OriginatingTo === "string"
          ? params.ctx.OriginatingTo.trim()
          : typeof params.ctx.To === "string"
            ? params.ctx.To.trim()
            : "";
      if (!channel || !to) {
        return undefined;
      }
      const accountId =
        typeof params.ctx.AccountId === "string" && params.ctx.AccountId.trim()
          ? params.ctx.AccountId
          : undefined;
      const threadId =
        typeof params.ctx.MessageThreadId === "string" && params.ctx.MessageThreadId.trim()
          ? params.ctx.MessageThreadId
          : typeof params.ctx.MessageThreadId === "number" &&
              Number.isFinite(params.ctx.MessageThreadId)
            ? params.ctx.MessageThreadId
            : undefined;
      return {
        sessionKey: params.sessionKey,
        channel,
        to,
        accountId,
        threadId,
      };
    })();
  if (!resolvedUpdate) {
    return;
  }
  if (shouldSkipPinnedMainDmRouteUpdate(resolvedUpdate.mainDmOwnerPin)) {
    return;
  }
  const targetSessionKey = normalizeLowercaseStringOrEmpty(resolvedUpdate.sessionKey);
  await runtime.updateLastRoute({
    storePath,
    sessionKey: targetSessionKey,
    deliveryContext: {
      channel: resolvedUpdate.channel,
      to: resolvedUpdate.to,
      accountId: resolvedUpdate.accountId,
      threadId: resolvedUpdate.threadId,
    },
    // Avoid leaking inbound origin metadata into a different target session.
    ctx: targetSessionKey === canonicalSessionKey ? ctx : undefined,
    groupResolution,
    createIfMissing,
  });
}
