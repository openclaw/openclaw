import { resolveRuntimePolicySessionKey } from "../auto-reply/reply/runtime-policy-session-key.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function resolveGatewaySessionRuntimePolicySessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  entry?: SessionEntry;
}): string | undefined {
  const origin = params.entry?.origin;
  const delivery = params.entry?.deliveryContext;
  const channel = delivery?.channel ?? origin?.provider ?? params.entry?.lastChannel;
  const to = delivery?.to ?? origin?.to ?? params.entry?.lastTo;
  return resolveRuntimePolicySessionKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    ctx: {
      SessionKey: params.sessionKey,
      AccountId: delivery?.accountId ?? origin?.accountId ?? params.entry?.lastAccountId,
      ChatType: origin?.chatType ?? params.entry?.chatType,
      From: origin?.from,
      NativeDirectUserId: origin?.nativeDirectUserId,
      OriginatingChannel: channel,
      OriginatingTo: to,
      Provider: origin?.provider ?? channel,
      SenderId: origin?.senderId ?? origin?.from,
      Surface: origin?.surface ?? origin?.provider ?? channel,
      To: to,
    },
  });
}
