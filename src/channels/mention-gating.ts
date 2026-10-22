import type { ChannelImplicitMentionsConfig } from "../config/types.channels.js";

export type InboundImplicitMentionKind =
  | "reply_to_bot"
  | "quoted_bot"
  | "bot_thread_participant"
  | "native";

export type InboundMentionFacts = {
  canDetectMention: boolean;
  wasMentioned: boolean;
  hasAnyMention?: boolean;
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
};

export type InboundMentionPolicy = {
  isGroup: boolean;
  requireMention: boolean;
  implicitMentions?: ChannelImplicitMentionsConfig;
  allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
};

/** @deprecated Prefer the nested `{ facts, policy }` call shape for new code. */
export type ResolveInboundMentionDecisionFlatParams = InboundMentionFacts & InboundMentionPolicy;

export type ResolveInboundMentionDecisionNestedParams = {
  facts: InboundMentionFacts;
  policy: InboundMentionPolicy;
};

export type ResolveInboundMentionDecisionParams =
  | ResolveInboundMentionDecisionFlatParams
  | ResolveInboundMentionDecisionNestedParams;

export type InboundMentionDecision = {
  effectiveWasMentioned: boolean;
  shouldSkip: boolean;
  implicitMention: boolean;
  matchedImplicitMentionKinds: InboundImplicitMentionKind[];
  shouldBypassMention: boolean;
};

export function implicitMentionKindWhen(
  kind: InboundImplicitMentionKind,
  enabled: boolean,
): InboundImplicitMentionKind[] {
  return enabled ? [kind] : [];
}

export function resolveBotThreadMentionPolicy(params: {
  isBotOwnedThread: boolean;
  requireMentionInBotThreads?: boolean;
  requireMention: boolean;
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
}): {
  requireMention: boolean;
  implicitMentionKinds: readonly InboundImplicitMentionKind[] | undefined;
} {
  if (!params.isBotOwnedThread || params.requireMentionInBotThreads === undefined) {
    return {
      requireMention: params.requireMention,
      implicitMentionKinds: params.implicitMentionKinds,
    };
  }
  return {
    requireMention: params.requireMentionInBotThreads,
    implicitMentionKinds: params.requireMentionInBotThreads
      ? params.implicitMentionKinds?.filter((kind) => kind === "native")
      : params.implicitMentionKinds,
  };
}

/** Translates positive implicit-mention policy into the evaluator's kind allowlist. */
export function allowedImplicitMentionKindsFromConfig(
  config: ChannelImplicitMentionsConfig,
): InboundImplicitMentionKind[] {
  return [
    ...implicitMentionKindWhen("reply_to_bot", config.replyToBot !== false),
    ...implicitMentionKindWhen("quoted_bot", config.quotedBot !== false),
    ...implicitMentionKindWhen("bot_thread_participant", config.threadParticipation !== false),
    "native",
  ];
}

export function resolveInboundMentionDecision(
  params: ResolveInboundMentionDecisionParams,
): InboundMentionDecision {
  const { facts, policy } =
    "facts" in params && "policy" in params ? params : { facts: params, policy: params };
  const allowedImplicitMentionKinds =
    policy.allowedImplicitMentionKinds ??
    (policy.implicitMentions
      ? allowedImplicitMentionKindsFromConfig(policy.implicitMentions)
      : undefined);
  const shouldBypassMention =
    policy.isGroup &&
    policy.requireMention &&
    !facts.wasMentioned &&
    !(facts.hasAnyMention ?? false) &&
    policy.allowTextCommands &&
    policy.commandAuthorized &&
    policy.hasControlCommand;
  const matchedImplicitMentionKinds = [...new Set(facts.implicitMentionKinds ?? [])].filter(
    (kind) => !allowedImplicitMentionKinds || allowedImplicitMentionKinds.includes(kind),
  );
  const implicitMention = matchedImplicitMentionKinds.length > 0;
  const effectiveWasMentioned = facts.wasMentioned || implicitMention || shouldBypassMention;
  return {
    implicitMention,
    matchedImplicitMentionKinds,
    effectiveWasMentioned,
    shouldBypassMention,
    shouldSkip: policy.requireMention && facts.canDetectMention && !effectiveWasMentioned,
  };
}
