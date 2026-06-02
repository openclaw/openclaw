/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
export type MentionGateParams = {
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMention?: boolean;
  shouldBypassMention?: boolean;
};

/** @deprecated Prefer `InboundMentionDecision`. */
export type MentionGateResult = {
  effectiveWasMentioned: boolean;
  shouldSkip: boolean;
};

/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
export type MentionGateWithBypassParams = {
  isGroup: boolean;
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMention?: boolean;
  hasAnyMention?: boolean;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
};

/** @deprecated Prefer `InboundMentionDecision`. */
export type MentionGateWithBypassResult = MentionGateResult & {
  shouldBypassMention: boolean;
};

export type InboundImplicitMentionKind =
  /** Message replied directly to a bot-authored message. */
  | "reply_to_bot"
  /** Message quoted bot-authored content. */
  | "quoted_bot"
  /** Message arrived in a thread where the bot is already a participant. */
  | "bot_thread_participant"
  /** Channel-native mention signal normalized by legacy callers. */
  | "native";

export type InboundMentionFacts = {
  /** True when the channel can reliably detect explicit mentions. */
  canDetectMention: boolean;
  /** True when the inbound message explicitly mentioned the bot. */
  wasMentioned: boolean;
  /** True when the message mentioned anyone, used to avoid command bypass ambiguity. */
  hasAnyMention?: boolean;
  /** Channel-derived implicit mention reasons that may satisfy mention gating. */
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
};

export type InboundMentionPolicy = {
  /** True for group-like conversations where mention gating applies. */
  isGroup: boolean;
  /** True when the channel/account requires bot mentions before responding. */
  requireMention: boolean;
  /** Optional allowlist limiting which implicit mention reasons count as mentions. */
  allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
  /** True when text control commands are enabled for this surface. */
  allowTextCommands: boolean;
  /** True when the inbound text contains a recognized control command. */
  hasControlCommand: boolean;
  /** True when access policy allows the sender to run the control command. */
  commandAuthorized: boolean;
};

/** @deprecated Prefer the nested `{ facts, policy }` call shape for new code. */
export type ResolveInboundMentionDecisionFlatParams = InboundMentionFacts & InboundMentionPolicy;

export type ResolveInboundMentionDecisionNestedParams = {
  /** Observed mention facts from the inbound message. */
  facts: InboundMentionFacts;
  /** Channel/account policy used to interpret the mention facts. */
  policy: InboundMentionPolicy;
};

export type ResolveInboundMentionDecisionParams =
  | ResolveInboundMentionDecisionFlatParams
  | ResolveInboundMentionDecisionNestedParams;

export type InboundMentionDecision = MentionGateResult & {
  /** True when at least one allowed implicit mention reason matched. */
  implicitMention: boolean;
  /** Deduped implicit mention reasons accepted by policy. */
  matchedImplicitMentionKinds: InboundImplicitMentionKind[];
  /** True when an authorized group control command bypassed explicit mention gating. */
  shouldBypassMention: boolean;
};

export function implicitMentionKindWhen(
  kind: InboundImplicitMentionKind,
  enabled: boolean,
): InboundImplicitMentionKind[] {
  return enabled ? [kind] : [];
}

function resolveMatchedImplicitMentionKinds(params: {
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
  allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
}): InboundImplicitMentionKind[] {
  const inputKinds = params.implicitMentionKinds ?? [];
  if (inputKinds.length === 0) {
    return [];
  }
  const allowedKinds = params.allowedImplicitMentionKinds
    ? new Set(params.allowedImplicitMentionKinds)
    : null;
  const matched: InboundImplicitMentionKind[] = [];
  for (const kind of inputKinds) {
    if (allowedKinds && !allowedKinds.has(kind)) {
      continue;
    }
    if (!matched.includes(kind)) {
      matched.push(kind);
    }
  }
  return matched;
}

function resolveMentionDecisionCore(params: {
  requireMention: boolean;
  canDetectMention: boolean;
  wasMentioned: boolean;
  implicitMentionKinds?: readonly InboundImplicitMentionKind[];
  allowedImplicitMentionKinds?: readonly InboundImplicitMentionKind[];
  shouldBypassMention: boolean;
}): InboundMentionDecision {
  const matchedImplicitMentionKinds = resolveMatchedImplicitMentionKinds({
    implicitMentionKinds: params.implicitMentionKinds,
    allowedImplicitMentionKinds: params.allowedImplicitMentionKinds,
  });
  const implicitMention = matchedImplicitMentionKinds.length > 0;
  const effectiveWasMentioned =
    params.wasMentioned || implicitMention || params.shouldBypassMention;
  const shouldSkip = params.requireMention && params.canDetectMention && !effectiveWasMentioned;
  return {
    implicitMention,
    matchedImplicitMentionKinds,
    effectiveWasMentioned,
    shouldBypassMention: params.shouldBypassMention,
    shouldSkip,
  };
}

function hasNestedMentionDecisionParams(
  params: ResolveInboundMentionDecisionParams,
): params is ResolveInboundMentionDecisionNestedParams {
  return "facts" in params && "policy" in params;
}

function normalizeMentionDecisionParams(
  params: ResolveInboundMentionDecisionParams,
): ResolveInboundMentionDecisionNestedParams {
  if (hasNestedMentionDecisionParams(params)) {
    return params;
  }
  const {
    canDetectMention,
    wasMentioned,
    hasAnyMention,
    implicitMentionKinds,
    isGroup,
    requireMention,
    allowedImplicitMentionKinds,
    allowTextCommands,
    hasControlCommand,
    commandAuthorized,
  } = params;
  return {
    facts: {
      canDetectMention,
      wasMentioned,
      hasAnyMention,
      implicitMentionKinds,
    },
    policy: {
      isGroup,
      requireMention,
      allowedImplicitMentionKinds,
      allowTextCommands,
      hasControlCommand,
      commandAuthorized,
    },
  };
}

/** Resolves whether mention policy allows, skips, or command-bypasses one inbound message. */
export function resolveInboundMentionDecision(
  params: ResolveInboundMentionDecisionParams,
): InboundMentionDecision {
  const { facts, policy } = normalizeMentionDecisionParams(params);
  // Authorized text commands may bypass mention gating only when the message names no one else.
  const shouldBypassMention =
    policy.isGroup &&
    policy.requireMention &&
    !facts.wasMentioned &&
    !(facts.hasAnyMention ?? false) &&
    policy.allowTextCommands &&
    policy.commandAuthorized &&
    policy.hasControlCommand;
  return resolveMentionDecisionCore({
    requireMention: policy.requireMention,
    canDetectMention: facts.canDetectMention,
    wasMentioned: facts.wasMentioned,
    implicitMentionKinds: facts.implicitMentionKinds,
    allowedImplicitMentionKinds: policy.allowedImplicitMentionKinds,
    shouldBypassMention,
  });
}

/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
export function resolveMentionGating(params: MentionGateParams): MentionGateResult {
  const result = resolveMentionDecisionCore({
    requireMention: params.requireMention,
    canDetectMention: params.canDetectMention,
    wasMentioned: params.wasMentioned,
    implicitMentionKinds: implicitMentionKindWhen("native", params.implicitMention === true),
    shouldBypassMention: params.shouldBypassMention === true,
  });
  return {
    effectiveWasMentioned: result.effectiveWasMentioned,
    shouldSkip: result.shouldSkip,
  };
}

/** @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`. */
export function resolveMentionGatingWithBypass(
  params: MentionGateWithBypassParams,
): MentionGateWithBypassResult {
  const result = resolveInboundMentionDecision({
    facts: {
      canDetectMention: params.canDetectMention,
      wasMentioned: params.wasMentioned,
      hasAnyMention: params.hasAnyMention,
      implicitMentionKinds: implicitMentionKindWhen("native", params.implicitMention === true),
    },
    policy: {
      isGroup: params.isGroup,
      requireMention: params.requireMention,
      allowTextCommands: params.allowTextCommands,
      hasControlCommand: params.hasControlCommand,
      commandAuthorized: params.commandAuthorized,
    },
  });
  return {
    effectiveWasMentioned: result.effectiveWasMentioned,
    shouldSkip: result.shouldSkip,
    shouldBypassMention: result.shouldBypassMention,
  };
}
