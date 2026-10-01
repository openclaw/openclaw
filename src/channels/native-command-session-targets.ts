import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ChannelMessagingAdapter } from "./plugins/types.core.js";

export type ResolveNativeCommandSessionTargetsParams = {
  agentId: string;
  sessionPrefix: string;
  userId: string;
  targetSessionKey: string;
  boundSessionKey?: string;
  sessionKeyCase?: NonNullable<ChannelMessagingAdapter["targetIdComparison"]>;
};

export function resolveNativeCommandSessionTargets(
  params: ResolveNativeCommandSessionTargetsParams,
) {
  const rawSessionKey =
    params.boundSessionKey ?? `agent:${params.agentId}:${params.sessionPrefix}:${params.userId}`;
  return {
    // Some providers normalize user ids case-insensitively; keep this opt-in so existing
    // case-sensitive bindings are preserved for channels that need them.
    sessionKey:
      params.sessionKeyCase === "lowercase"
        ? normalizeLowercaseStringOrEmpty(rawSessionKey)
        : rawSessionKey,
    commandTargetSessionKey: params.boundSessionKey ?? params.targetSessionKey,
  };
}
