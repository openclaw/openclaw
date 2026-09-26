// Normalizes silent-reply config for channel response suppression.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  classifySilentReplyConversationType,
  resolveSilentReplyPolicyFromPolicies,
  type SilentReplyConversationType,
  type SilentReplyPolicy,
} from "../shared/silent-reply-policy.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Resolves the effective silent-reply settings for a routed conversation. */
export function resolveSilentReplySettings(params: {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  surface?: string;
  conversationType?: SilentReplyConversationType;
}): {
  policy: SilentReplyPolicy;
} {
  const conversationType = classifySilentReplyConversationType({
    sessionKey: params.sessionKey,
    surface: params.surface,
    conversationType: params.conversationType,
  });
  const normalizedSurface = normalizeLowercaseStringOrEmpty(params.surface);
  // Surfaces are stored under normalized ids; keep explicit conversationType untouched.
  const surface = normalizedSurface ? params.cfg?.surfaces?.[normalizedSurface] : undefined;
  return {
    policy: resolveSilentReplyPolicyFromPolicies({
      conversationType,
      defaultPolicy: params.cfg?.agents?.defaults?.silentReply,
      surfacePolicy: surface?.silentReply,
    }),
  };
}
