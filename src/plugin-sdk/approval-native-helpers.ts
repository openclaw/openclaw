import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../packages/normalization-core/src/string-coerce.js";
import type { ExecApprovalForwardingConfig } from "../config/types.approvals.js";
import {
  doesApprovalRequestSelectChannelAccount,
  doesApprovalRequestSelectChannelAccountAsync,
  resolveApprovalRequestSessionDeliveryAsync,
} from "../infra/approval-request-account-binding.js";
import { matchesApprovalRequestFilters } from "../infra/approval-request-filters.js";
import { resolveApprovalRequestKind, type ChannelApprovalKind } from "../infra/approval-types.js";
import {
  getExecApprovalReplyMetadata,
  type ExecApprovalReplyMetadata,
} from "../infra/exec-approval-reply.js";
import {
  resolveApprovalRequestSessionTarget,
  resolveApprovalRequestSessionTargetAsync,
  type ExecApprovalSessionTarget,
} from "../infra/exec-approval-session-target.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type {
  ApprovalRequest,
  DeliverySuppressionInput,
  NativeApprovalForwardTarget,
  LocalNativeExecApprovalConfig,
  ApprovalResolverParams,
  ChannelApprovalForwardingEligibilityParams,
  ChannelApprovalPotentialRouteParams,
  ChannelApprovalExplicitTargetEligibilityParams,
  NativeApprovalForwardingFallbackSuppressorParams,
  NativeApprovalForwardingFallbackSuppressorAsyncParams,
  NativeApprovalChannelRouteGateParams,
  NativeApprovalChannelRouteGates,
  NativeApprovalTarget,
} from "./approval-native-helpers.types.js";
import { nativeApprovalTargetsMatch } from "./approval-native-target-resolvers.js";
import type { ChannelApprovalCapability, ChannelOutboundPayloadHint } from "./channel-contract.js";
import type { OpenClawConfig } from "./config-contracts.js";
import type { ReplyPayload } from "./reply-payload.js";

/**
 * Create the standard target adapters for messaging channels whose native
 * approval destination is a normalized `to` value.
 */
export function createNativeApprovalMessagingTargetResolvers(params: {
  /** Lowercase channel id used by forwarding and turn-source routes. */
  channel: string;
  /** Channel-owned destination normalizer. */
  normalizeTo: (to: string) => string | null | undefined;
}): {
  normalizeForwardTarget: (target: NativeApprovalForwardTarget) => NativeApprovalTarget | null;
  resolveTurnSourceTarget: (request: ApprovalRequest) => NativeApprovalTarget | null;
  resolveSessionTarget: (sessionTarget: ExecApprovalSessionTarget) => NativeApprovalTarget | null;
  normalizeTarget: (target: NativeApprovalTarget) => NativeApprovalTarget | null;
} {
  const normalizeTo = (to: string): string | null => params.normalizeTo(to) || null;
  const normalizeTarget = (target: NativeApprovalTarget): NativeApprovalTarget | null => {
    const to = normalizeTo(target.to);
    return to ? { ...target, to } : null;
  };

  return {
    normalizeForwardTarget: (target) => {
      if (normalizeLowercaseStringOrEmpty(target.channel) !== params.channel) {
        return null;
      }
      const to = normalizeTo(target.to);
      return to
        ? {
            to,
            accountId: normalizeOptionalString(target.accountId),
            threadId: target.threadId ?? null,
          }
        : null;
    },
    resolveTurnSourceTarget: (request) => {
      if (normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel) !== params.channel) {
        return null;
      }
      const to = normalizeTo(request.request.turnSourceTo ?? "");
      return to
        ? {
            to,
            accountId: normalizeOptionalString(request.request.turnSourceAccountId),
          }
        : null;
    },
    resolveSessionTarget: (sessionTarget) => {
      const to = normalizeTo(sessionTarget.to);
      return to
        ? {
            to,
            accountId: normalizeOptionalString(sessionTarget.accountId),
          }
        : null;
    },
    normalizeTarget,
  };
}

/** Decide whether a channel-native exec approval route replaces the local text prompt. */
export function shouldSuppressLocalNativeExecApprovalPrompt(params: {
  /** Full config containing top-level or channel-specific approval settings. */
  cfg: OpenClawConfig;
  /** Optional channel account id for account-scoped native delivery checks. */
  accountId?: string | null;
  /** Reply payload that may already contain exec approval metadata. */
  payload: ReplyPayload;
  /** Outbound payload hint proving an active native exec approval route. */
  hint?: ChannelOutboundPayloadHint;
  /** Legacy transport gate for native delivery. */
  isTransportEnabled?: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  /** Preferred transport gate for native delivery. */
  isNativeDeliveryEnabled?: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  /** Optional channel-specific approval config resolver. */
  resolveApprovalConfig?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    metadata: ExecApprovalReplyMetadata;
  }) => LocalNativeExecApprovalConfig | undefined;
  /** Whether the resolved approval config must be enabled before suppressing local prompt. */
  requireApprovalConfigEnabled?: boolean;
  /** Whether forwarding mode must be session/both unless exact target proof is present. */
  enforceForwardingMode?: boolean;
  /** Optional session-route gate for the approval metadata. */
  isSessionRouteEligible?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    metadata: ExecApprovalReplyMetadata;
  }) => boolean;
  /** Proof that target-mode forwarding already matched this exact native target. */
  hasExactTargetProof?: boolean;
  /** Whether agent filters may fall back to the agent segment in sessionKey. */
  fallbackAgentIdFromSessionKey?: boolean;
}): boolean {
  if (params.hint?.kind !== "approval-pending" || params.hint.approvalKind !== "exec") {
    return false;
  }
  if (params.hint.nativeRouteActive !== true) {
    return false;
  }
  const metadata = getExecApprovalReplyMetadata(params.payload);
  if (!metadata || metadata.approvalKind !== "exec") {
    return false;
  }
  const isDeliveryEnabled = params.isNativeDeliveryEnabled ?? params.isTransportEnabled;
  if (!isDeliveryEnabled?.({ cfg: params.cfg, accountId: params.accountId })) {
    return false;
  }
  const config =
    params.resolveApprovalConfig?.({
      cfg: params.cfg,
      accountId: params.accountId,
      metadata,
    }) ?? params.cfg.approvals?.exec;
  const requireConfigEnabled =
    params.requireApprovalConfigEnabled ?? params.resolveApprovalConfig === undefined;
  if (requireConfigEnabled && !config?.enabled) {
    return false;
  }
  const enforceForwardingMode =
    params.enforceForwardingMode ?? params.resolveApprovalConfig === undefined;
  if (enforceForwardingMode) {
    const mode = config?.mode ?? "session";
    // In targets-only mode, local prompt suppression requires exact target
    // proof so a session/native route cannot hide the only visible prompt.
    if (mode !== "session" && mode !== "both" && !params.hasExactTargetProof) {
      return false;
    }
  }
  if (
    params.isSessionRouteEligible &&
    !params.isSessionRouteEligible({
      cfg: params.cfg,
      accountId: params.accountId,
      metadata,
    })
  ) {
    return false;
  }
  return matchesApprovalRequestFilters({
    request: {
      agentId: metadata.agentId,
      sessionKey: metadata.sessionKey,
    },
    agentFilter: config?.agentFilter,
    sessionFilter: config?.sessionFilter,
    fallbackAgentIdFromSessionKey: params.fallbackAgentIdFromSessionKey ?? true,
  });
}

/** Infer approval family from the request shape unless the caller already knows it. */
export function resolveApprovalKind(
  request: ApprovalRequest,
  approvalKind?: ChannelApprovalKind,
): ChannelApprovalKind {
  if (approvalKind) {
    return approvalKind;
  }
  return resolveApprovalRequestKind(request);
}

function matchesForwardingFilters(params: {
  config: ExecApprovalForwardingConfig;
  request: ApprovalRequest;
}): boolean {
  return matchesApprovalRequestFilters({
    request: params.request.request,
    agentFilter: params.config.agentFilter,
    sessionFilter: params.config.sessionFilter,
    fallbackAgentIdFromSessionKey: true,
  });
}

function createNativeApprovalChannelRoutePolicy<TTarget extends NativeApprovalTarget>(
  params: NativeApprovalChannelRouteGateParams<TTarget>,
) {
  const resolveActiveForwarding = (input: ChannelApprovalPotentialRouteParams) => {
    if (!params.isTransportEnabled(input)) {
      return null;
    }
    const config =
      input.approvalKind === "plugin" ? input.cfg.approvals?.plugin : input.cfg.approvals?.exec;
    return config?.enabled ? { config, mode: config.mode ?? params.defaultForwardingMode } : null;
  };

  const targetsMatch =
    params.targetsMatch ??
    ((left: TTarget, right: TTarget) =>
      nativeApprovalTargetsMatch({ channel: params.channel, left, right }));

  const targetAccountMatchesChannelAccount = (input: {
    cfg: OpenClawConfig;
    targetAccountId?: string | null;
    accountId?: string | null;
  }): boolean => {
    const targetAccountId = normalizeOptionalString(input.targetAccountId);
    const accountId = normalizeOptionalString(input.accountId);
    if (targetAccountId) {
      return !accountId || normalizeAccountId(targetAccountId) === normalizeAccountId(accountId);
    }
    if (!accountId) {
      return true;
    }
    const normalizedAccountId = normalizeAccountId(accountId);
    const defaultAccountId = normalizeAccountId(params.resolveDefaultAccountId(input.cfg));
    return normalizedAccountId === defaultAccountId;
  };

  const hasMatchingChannelTarget = (input: {
    cfg: OpenClawConfig;
    config: ExecApprovalForwardingConfig;
    accountId?: string | null;
    target?: NativeApprovalForwardTarget;
  }): boolean => {
    const candidateTarget = input.target ? params.normalizeForwardTarget(input.target) : null;
    return (input.config.targets ?? []).some((target) => {
      const configuredTarget = params.normalizeForwardTarget(target);
      if (!configuredTarget) {
        return false;
      }
      if (
        !targetAccountMatchesChannelAccount({
          cfg: input.cfg,
          targetAccountId: configuredTarget.accountId,
          accountId: input.accountId,
        })
      ) {
        return false;
      }
      if (!candidateTarget) {
        return true;
      }
      return targetsMatch(configuredTarget, candidateTarget);
    });
  };

  const canApprovalPotentiallyRouteToChannel = (
    input: ChannelApprovalPotentialRouteParams,
  ): boolean => {
    const forwarding = resolveActiveForwarding(input);
    if (!forwarding) {
      return false;
    }
    if (forwarding.mode === "session" || forwarding.mode === "both") {
      return true;
    }
    return (
      !input.nativeSessionOnly &&
      forwarding.mode === "targets" &&
      hasMatchingChannelTarget({
        cfg: input.cfg,
        config: forwarding.config,
        accountId: input.accountId,
      })
    );
  };

  const canAnyApprovalPotentiallyRouteToChannel = (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    nativeSessionOnly?: boolean;
  }): boolean =>
    (["exec", "plugin", "system-agent"] as const).some((approvalKind) =>
      canApprovalPotentiallyRouteToChannel({ ...input, approvalKind }),
    );

  const isExplicitTargetEligible = (
    input: ChannelApprovalExplicitTargetEligibilityParams,
  ): boolean => {
    const forwarding = resolveActiveForwarding(input);
    return (
      forwarding !== null &&
      (forwarding.mode === "targets" || forwarding.mode === "both") &&
      matchesForwardingFilters({ config: forwarding.config, request: input.request }) &&
      hasMatchingChannelTarget({
        cfg: input.cfg,
        config: forwarding.config,
        accountId: input.accountId,
        target: input.target,
      })
    );
  };

  return {
    canApprovalPotentiallyRouteToChannel,
    canAnyApprovalPotentiallyRouteToChannel,
    isNativeApprovalHandlerConfigured: (input: {
      cfg: OpenClawConfig;
      accountId?: string | null;
    }) => canAnyApprovalPotentiallyRouteToChannel({ ...input, nativeSessionOnly: true }),
    isExplicitTargetEligible,
    resolveActiveForwarding,
    targetAccountMatchesChannelAccount,
  };
}

/** @deprecated Use createNativeApprovalChannelRouteGatesAsync for worker-owned session reads. */
export function createNativeApprovalChannelRouteGates<TTarget extends NativeApprovalTarget>(
  params: NativeApprovalChannelRouteGateParams<TTarget>,
): NativeApprovalChannelRouteGates {
  warnPluginSdkDeprecation({
    family: "approval-session-routing",
    method: "createNativeApprovalChannelRouteGates",
    replacement: "createNativeApprovalChannelRouteGatesAsync",
  });
  const policy = createNativeApprovalChannelRoutePolicy(params);
  const { resolveActiveForwarding, targetAccountMatchesChannelAccount, ...gates } = policy;
  const hasChannelOriginOrSessionTarget = (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    request: ApprovalRequest;
  }): boolean => {
    if (params.resolveTurnSourceTarget(input.request)) {
      return true;
    }

    const sessionTarget = resolveApprovalRequestSessionTarget({
      cfg: input.cfg,
      request: input.request,
    });
    return (
      normalizeLowercaseStringOrEmpty(sessionTarget?.channel) === params.channel &&
      targetAccountMatchesChannelAccount({
        cfg: input.cfg,
        targetAccountId: sessionTarget?.accountId,
        accountId: input.accountId,
      })
    );
  };

  const isSessionApprovalEligible = (
    input: ChannelApprovalForwardingEligibilityParams,
  ): boolean => {
    // Per-account runtimes report raw candidates here. The route coordinator rejects
    // unbound multi-account groups as ambiguous before any runtime can deliver.
    const accountId = input.accountId ?? params.resolveDefaultAccountId(input.cfg);
    const eligibleAccountIds = params.isTransportEnabled({ cfg: input.cfg, accountId })
      ? [accountId]
      : [];
    if (
      !doesApprovalRequestSelectChannelAccount({
        cfg: input.cfg,
        request: input.request,
        channel: params.channel,
        accountId: input.accountId,
        defaultAccountId: params.resolveDefaultAccountId(input.cfg),
        eligibleAccountIds,
      })
    ) {
      return false;
    }
    const forwarding = resolveActiveForwarding(input);
    return (
      forwarding !== null &&
      (forwarding.mode === "session" || forwarding.mode === "both") &&
      matchesForwardingFilters({ config: forwarding.config, request: input.request }) &&
      hasChannelOriginOrSessionTarget({
        cfg: input.cfg,
        accountId: input.accountId,
        request: input.request,
      })
    );
  };

  return {
    ...gates,
    shouldHandleApprovalRequest: (input) =>
      isSessionApprovalEligible({
        ...input,
        approvalKind: resolveApprovalKind(input.request, input.approvalKind),
      }),
    isSessionApprovalEligible,
  };
}

/** Create native route gates whose session-dependent checks run through the history worker. */
export function createNativeApprovalChannelRouteGatesAsync<TTarget extends NativeApprovalTarget>(
  params: NativeApprovalChannelRouteGateParams<TTarget>,
): Omit<
  NativeApprovalChannelRouteGates,
  "isSessionApprovalEligible" | "shouldHandleApprovalRequest"
> & {
  isSessionApprovalEligible: (
    input: ChannelApprovalForwardingEligibilityParams,
  ) => Promise<boolean>;
  shouldHandleApprovalRequest: (input: ApprovalResolverParams) => Promise<boolean>;
} {
  const { resolveActiveForwarding, targetAccountMatchesChannelAccount, ...gates } =
    createNativeApprovalChannelRoutePolicy(params);
  const isSessionApprovalEligible = async (input: ChannelApprovalForwardingEligibilityParams) => {
    const forwarding = resolveActiveForwarding(input);
    if (
      !forwarding ||
      (forwarding.mode !== "session" && forwarding.mode !== "both") ||
      !matchesForwardingFilters({ config: forwarding.config, request: input.request })
    ) {
      return false;
    }
    const accountId = input.accountId ?? params.resolveDefaultAccountId(input.cfg);
    const sessionDelivery =
      input.sessionDelivery === undefined
        ? await resolveApprovalRequestSessionDeliveryAsync(input)
        : input.sessionDelivery;
    if (
      !(await doesApprovalRequestSelectChannelAccountAsync({
        sessionDelivery,
        cfg: input.cfg,
        request: input.request,
        channel: params.channel,
        accountId: input.accountId,
        defaultAccountId: params.resolveDefaultAccountId(input.cfg),
        eligibleAccountIds: params.isTransportEnabled({ cfg: input.cfg, accountId })
          ? [accountId]
          : [],
      }))
    ) {
      return false;
    }
    if (params.resolveTurnSourceTarget(input.request)) {
      return true;
    }
    const target = await resolveApprovalRequestSessionTargetAsync({ ...input, sessionDelivery });
    return (
      normalizeLowercaseStringOrEmpty(target?.channel) === params.channel &&
      targetAccountMatchesChannelAccount({
        cfg: input.cfg,
        targetAccountId: target?.accountId,
        accountId: input.accountId,
      })
    );
  };
  return {
    ...gates,
    isSessionApprovalEligible,
    shouldHandleApprovalRequest: (input) =>
      isSessionApprovalEligible({
        ...input,
        approvalKind: resolveApprovalKind(input.request, input.approvalKind),
      }),
  };
}

type ForwardingMatchParams<TTarget extends NativeApprovalTarget> = Pick<
  NativeApprovalForwardingFallbackSuppressorParams<TTarget>,
  | "channel"
  | "normalizeForwardTarget"
  | "resolveAccountId"
  | "resolveApprovalKind"
  | "resolveForwardingTargetForMatch"
  | "targetsMatch"
>;

function prepareForwardingMatch<TTarget extends NativeApprovalTarget>(
  params: ForwardingMatchParams<TTarget>,
  input: DeliverySuppressionInput,
) {
  const forwardingTarget = params.normalizeForwardTarget(input.target);
  if (!forwardingTarget) {
    return null;
  }
  const accountId =
    normalizeOptionalString(
      params.resolveAccountId?.({ forwardingTarget, target: input.target, request: input.request }),
    ) ??
    normalizeOptionalString(forwardingTarget.accountId) ??
    normalizeOptionalString(input.request.request.turnSourceAccountId);
  const approvalKind =
    params.resolveApprovalKind?.({ approvalKind: input.approvalKind, request: input.request }) ??
    resolveApprovalKind(input.request, input.approvalKind);
  const requestParams = { cfg: input.cfg, accountId, approvalKind, request: input.request };
  const forwardingTargetForMatch =
    params.resolveForwardingTargetForMatch?.({
      forwardingTarget,
      accountId,
      target: input.target,
      approvalKind,
      request: input.request,
    }) ?? forwardingTarget;
  const targetsMatch =
    params.targetsMatch ??
    ((left: TTarget, right: TTarget) =>
      nativeApprovalTargetsMatch({ channel: params.channel, left, right }));
  return {
    requestParams,
    matches: (target: TTarget) => targetsMatch(forwardingTargetForMatch, target),
  };
}

/** @deprecated Use createNativeApprovalForwardingFallbackSuppressorAsync with awaited route eligibility. */
export function createNativeApprovalForwardingFallbackSuppressor<
  TTarget extends NativeApprovalTarget,
>(
  params: NativeApprovalForwardingFallbackSuppressorParams<TTarget>,
): NonNullable<
  NonNullable<ChannelApprovalCapability["delivery"]>["shouldSuppressForwardingFallback"]
> {
  warnPluginSdkDeprecation({
    family: "approval-session-routing",
    method: "createNativeApprovalForwardingFallbackSuppressor",
    replacement: "createNativeApprovalForwardingFallbackSuppressorAsync",
  });
  return (input) => {
    const prepared = prepareForwardingMatch(params, input);
    if (!prepared) {
      return false;
    }
    const { requestParams, matches } = prepared;
    const eligible =
      input.target.source === "target"
        ? (params.isExplicitTargetEligible?.({ ...requestParams, target: input.target }) ?? false)
        : params.isSessionRouteEligible(requestParams);
    if (!eligible) {
      return false;
    }
    const originTarget = params.resolveOriginTarget(requestParams);
    return (
      Boolean(originTarget && matches(originTarget)) ||
      params.resolveApproverDmTargets(requestParams).some(matches)
    );
  };
}

/** Create a fallback suppressor for asynchronously prepared native routes. */
export function createNativeApprovalForwardingFallbackSuppressorAsync<
  TTarget extends NativeApprovalTarget,
>(
  params: NativeApprovalForwardingFallbackSuppressorAsyncParams<TTarget>,
): NonNullable<
  NonNullable<ChannelApprovalCapability["delivery"]>["shouldSuppressForwardingFallbackAsync"]
> {
  return async (input) => {
    const prepared = prepareForwardingMatch(params, input);
    if (!prepared) {
      return false;
    }
    const sessionDelivery = await resolveApprovalRequestSessionDeliveryAsync(input);
    const requestParams = { ...prepared.requestParams, sessionDelivery };
    const eligible = await (input.target.source === "target"
      ? (params.isExplicitTargetEligible?.({ ...requestParams, target: input.target }) ?? false)
      : params.isSessionRouteEligible(requestParams));
    if (!eligible) {
      return false;
    }
    const originTarget = await params.resolveOriginTarget(requestParams);
    return (
      Boolean(originTarget && prepared.matches(originTarget)) ||
      (await params.resolveApproverDmTargets(requestParams)).some(prepared.matches)
    );
  };
}

export {
  createChannelApproverDmTargetResolver,
  createChannelApproverDmTargetResolverAsync,
  createChannelNativeOriginTargetResolver,
  createChannelNativeOriginTargetResolverAsync,
  nativeApprovalTargetsMatch,
} from "./approval-native-target-resolvers.js";
export type {
  ChannelApprovalForwardingEligibilityParams,
  ChannelApprovalPotentialRouteParams,
  ChannelApprovalExplicitTargetEligibilityParams,
  NativeApprovalTarget,
} from "./approval-native-helpers.types.js";
