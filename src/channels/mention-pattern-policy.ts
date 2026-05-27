import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import type { MentionPatternsMode, MentionPatternsPolicyConfig } from "../config/types.messages.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export type ResolveMentionPatternPolicyParams = {
  cfg?: OpenClawConfig;
  provider?: string;
  conversationId?: string | null;
  providerPolicy?: MentionPatternsPolicyConfig;
  agentId?: string;
};

export type ResolvedMentionPatternPolicy = {
  provider?: string;
  conversationId?: string;
  globalMode: MentionPatternsMode;
  effectiveMode: MentionPatternsMode;
  allowMatched: boolean;
  denyMatched: boolean;
  enabled: boolean;
};

function normalizeIdList(values?: string[]): Set<string> {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const next = normalizeOptionalString(value);
    if (next) {
      normalized.add(next);
    }
  }
  return normalized;
}

function isMentionPatternsPolicyConfig(value: unknown): value is MentionPatternsPolicyConfig {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function resolveProviderMentionPatternsPolicy(
  cfg: OpenClawConfig | undefined,
  provider: string | undefined,
): MentionPatternsPolicyConfig | undefined {
  if (!cfg || !provider) {
    return undefined;
  }
  const policy = cfg.channels?.[provider]?.mentionPatterns;
  return isMentionPatternsPolicyConfig(policy) ? policy : undefined;
}

export function resolveMentionPatternPolicy(
  params: ResolveMentionPatternPolicyParams,
): ResolvedMentionPatternPolicy {
  const conversationId = normalizeOptionalString(params.conversationId ?? undefined) ?? undefined;
  const agentConfig =
    params.cfg && params.agentId ? resolveAgentConfig(params.cfg, params.agentId) : undefined;
  const globalMode =
    agentConfig?.groupChat && Object.hasOwn(agentConfig.groupChat, "mentionPatternsMode")
      ? (agentConfig.groupChat.mentionPatternsMode ?? "allow")
      : (params.cfg?.messages?.groupChat?.mentionPatternsMode ?? "allow");
  const providerPolicy =
    params.providerPolicy ?? resolveProviderMentionPatternsPolicy(params.cfg, params.provider);
  const effectiveMode =
    providerPolicy?.mode === "allow" || providerPolicy?.mode === "deny"
      ? providerPolicy.mode
      : globalMode;
  const allowMatched =
    conversationId != null && normalizeIdList(providerPolicy?.allowIn).has(conversationId);
  const denyMatched =
    conversationId != null && normalizeIdList(providerPolicy?.denyIn).has(conversationId);
  // allowIn only opens conversations when the effective mode is "deny"; in "allow" mode,
  // patterns are already enabled everywhere except denyIn.
  const enabled = effectiveMode === "allow" ? !denyMatched : allowMatched && !denyMatched;

  return {
    provider: params.provider,
    conversationId,
    globalMode,
    effectiveMode,
    allowMatched,
    denyMatched,
    enabled,
  };
}

export function resolveMentionPatternsEnabled(params: ResolveMentionPatternPolicyParams): boolean {
  return resolveMentionPatternPolicy(params).enabled;
}
