import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ReactionBundleContext } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions.js";
import { buildReactionPrompt } from "./context-builder.js";

function resolveReactionReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!replyResult) {
    return undefined;
  }
  if (!Array.isArray(replyResult)) {
    return replyResult;
  }
  // Iterate backwards: prefer the last non-empty payload (closest to final agent output).
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (payload && (payload.text || payload.mediaUrl || payload.mediaUrls?.length)) {
      return payload;
    }
  }
  return undefined;
}

export async function dispatchReactionEvent(bundle: ReactionBundleContext): Promise<void> {
  const cfg = loadConfig();
  const prompt = buildReactionPrompt(bundle);

  // Import getReplyFromConfig and deliverOutboundPayloads dynamically to avoid circular deps
  const { getReplyFromConfig } = await import("../../auto-reply/reply.js");
  const { deliverOutboundPayloads } = await import("../outbound/deliver.js");
  const { resolveHeartbeatDeliveryTarget } = await import("../outbound/targets.js");
  const { loadSessionStore } = await import("../../config/sessions/store.js");

  // Resolve the session entry to get delivery context
  const sessionCfg = cfg.session;
  const storePath = resolveStorePath(sessionCfg?.store);
  const sessionStore = loadSessionStore(storePath);
  const entry = sessionStore[bundle.sessionKey];

  const delivery = resolveHeartbeatDeliveryTarget({
    cfg,
    entry,
  });

  if (delivery.channel === "none" || !delivery.to) {
    return;
  }

  const ctx = {
    Body: prompt,
    From: delivery.to,
    To: delivery.to,
    Provider: "reaction-event",
    SessionKey: bundle.sessionKey,
  };

  const result = await getReplyFromConfig(ctx, undefined, cfg);
  const replyPayload = resolveReactionReplyPayload(result);

  if (
    !replyPayload ||
    (!replyPayload.text && !replyPayload.mediaUrl && !replyPayload.mediaUrls?.length)
  ) {
    return;
  }

  await deliverOutboundPayloads({
    cfg,
    channel: delivery.channel,
    to: delivery.to,
    accountId: delivery.accountId ?? bundle.accountId,
    payloads: [replyPayload],
  });
}
