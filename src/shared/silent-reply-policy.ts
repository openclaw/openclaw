import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Whether a reply may be suppressed instead of delivered visibly to the channel. */
export type SilentReplyPolicy = "allow" | "disallow";
/** Conversation class used to resolve silent-reply policy. */
export type SilentReplyConversationType = "direct" | "group" | "internal";
/** Config shape for policy overrides; direct chats are intentionally not configurable. */
export type SilentReplyPolicyShape = Partial<
  Record<Exclude<SilentReplyConversationType, "direct">, SilentReplyPolicy>
>;

/** Default silent-reply policy before agent or surface overrides are applied. */
export const DEFAULT_SILENT_REPLY_POLICY: Record<SilentReplyConversationType, SilentReplyPolicy> = {
  direct: "disallow",
  group: "allow",
  internal: "allow",
};

/** Classifies a reply context for silent-reply policy from explicit type, session key, or surface. */
export function classifySilentReplyConversationType(params: {
  /** Session key whose channel marker can imply direct/group scope. */
  sessionKey?: string;
  /** Surface id used when the session key has no channel marker. */
  surface?: string;
  /** Explicit classification, preferred when the caller already knows the conversation type. */
  conversationType?: SilentReplyConversationType;
}): SilentReplyConversationType {
  if (params.conversationType) {
    return params.conversationType;
  }
  const normalizedSessionKey = normalizeLowercaseStringOrEmpty(params.sessionKey);
  if (normalizedSessionKey.includes(":group:") || normalizedSessionKey.includes(":channel:")) {
    return "group";
  }
  if (normalizedSessionKey.includes(":direct:") || normalizedSessionKey.includes(":dm:")) {
    return "direct";
  }
  const normalizedSurface = normalizeLowercaseStringOrEmpty(params.surface);
  // Webchat behaves like a direct user conversation even when no channel session marker exists.
  if (normalizedSurface === "webchat") {
    return "direct";
  }
  return "internal";
}

/** Resolves silent-reply policy with surface overrides while keeping direct replies audible. */
export function resolveSilentReplyPolicyFromPolicies(params: {
  /** Classified conversation type for the pending reply. */
  conversationType: SilentReplyConversationType;
  /** Agent/default-level policy overrides. */
  defaultPolicy?: SilentReplyPolicyShape;
  /** Surface-specific overrides that take precedence over defaultPolicy. */
  surfacePolicy?: SilentReplyPolicyShape;
}): SilentReplyPolicy {
  if (params.conversationType === "direct") {
    // Direct chats must never be silently swallowed, regardless of config overlays.
    return "disallow";
  }
  return (
    params.surfacePolicy?.[params.conversationType] ??
    params.defaultPolicy?.[params.conversationType] ??
    DEFAULT_SILENT_REPLY_POLICY[params.conversationType]
  );
}
