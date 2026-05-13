import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import {
  classifySilentReplyConversationType,
  resolveSilentReplyPolicyFromPolicies,
  resolveSilentReplyRewriteFromPolicies,
  type SilentReplyConversationType,
  type SilentReplyPolicy,
  type SilentReplyPolicyShape,
  type SilentReplyRewriteShape,
} from "../shared/silent-reply-policy.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type ResolveSilentReplyParams = {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  surface?: string;
  conversationType?: SilentReplyConversationType;
};

function deriveSilentReplyConversationTypeFromSessionKey(
  sessionKey: string | undefined,
): SilentReplyConversationType | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  const rest = parsed?.rest ?? sessionKey;
  const parts = normalizeLowercaseStringOrEmpty(rest).split(":");
  for (const part of parts) {
    if (part === "direct" || part === "dm") {
      return "direct";
    }
    if (part === "group" || part === "channel") {
      return "group";
    }
  }
  return undefined;
}

function resolveSilentReplyConversationContext(params: ResolveSilentReplyParams): {
  conversationType: SilentReplyConversationType;
  defaultPolicy?: SilentReplyPolicyShape;
  defaultRewrite?: SilentReplyRewriteShape;
  surfacePolicy?: SilentReplyPolicyShape;
  surfaceRewrite?: SilentReplyRewriteShape;
} {
  const conversationType = classifySilentReplyConversationType({
    surface: params.surface,
    conversationType:
      params.conversationType ?? deriveSilentReplyConversationTypeFromSessionKey(params.sessionKey),
  });
  const normalizedSurface = normalizeLowercaseStringOrEmpty(params.surface);
  const surface = normalizedSurface ? params.cfg?.surfaces?.[normalizedSurface] : undefined;
  return {
    conversationType,
    defaultPolicy: params.cfg?.agents?.defaults?.silentReply,
    defaultRewrite: params.cfg?.agents?.defaults?.silentReplyRewrite,
    surfacePolicy: surface?.silentReply,
    surfaceRewrite: surface?.silentReplyRewrite,
  };
}

export function resolveSilentReplySettings(params: ResolveSilentReplyParams): {
  policy: SilentReplyPolicy;
  rewrite: boolean;
} {
  const context = resolveSilentReplyConversationContext(params);
  return {
    policy: resolveSilentReplyPolicyFromPolicies(context),
    rewrite: resolveSilentReplyRewriteFromPolicies(context),
  };
}

export function resolveSilentReplyPolicy(params: ResolveSilentReplyParams): SilentReplyPolicy {
  return resolveSilentReplySettings(params).policy;
}

export function resolveSilentReplyRewriteEnabled(params: ResolveSilentReplyParams): boolean {
  return resolveSilentReplySettings(params).rewrite;
}
