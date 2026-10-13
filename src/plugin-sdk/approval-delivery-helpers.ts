import { resolveApprovalRequestSessionDeliveryAsync } from "../infra/approval-request-account-binding.js";
import {
  isPluginApprovalRequest,
  type ChannelApprovalKind,
  type ApprovalRequestInput as NativeApprovalRequest,
} from "../infra/approval-types.js";
// Approval delivery helpers format approval prompts and results for channel plugins.
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import type {
  NativeApprovalDeliveryMode,
  NativeApprovalSurface,
  DeliverySuppressionParams,
  ApproverRestrictedNativeApprovalCommonParams,
  ApproverRestrictedNativeApprovalFlatParams,
  ApproverRestrictedNativeApprovalAsyncParams,
} from "./approval-delivery-helpers.types.js";
import {
  createChannelApproverDmTargetResolver,
  createChannelApproverDmTargetResolverAsync,
  createChannelNativeOriginTargetResolver,
  createChannelNativeOriginTargetResolverAsync,
  createNativeApprovalChannelRouteGates,
  createNativeApprovalChannelRouteGatesAsync,
  createNativeApprovalForwardingFallbackSuppressor,
  createNativeApprovalForwardingFallbackSuppressorAsync,
  createNativeApprovalMessagingTargetResolvers,
  type NativeApprovalTarget,
} from "./approval-native-helpers.js";
import type { ChannelApprovalCapability } from "./channel-contract.js";
import type { OpenClawConfig } from "./config-contracts.js";
import { normalizeMessageChannel } from "./routing.js";
import { normalizeOptionalString } from "./string-coerce-runtime.js";

function createApproverRestrictedAuth(
  params: ApproverRestrictedNativeApprovalCommonParams &
    Pick<
      ApproverRestrictedNativeApprovalFlatParams,
      "hasApprovers" | "isExecAuthorizedSender" | "isPluginAuthorizedSender"
    >,
): ChannelApprovalCapability {
  const pluginSenderAuth = params.isPluginAuthorizedSender ?? params.isExecAuthorizedSender;
  return {
    authorizeActorAction: ({ cfg, accountId, senderId, approvalKind, request }) => {
      const pluginRequest =
        approvalKind === "plugin" && request && isPluginApprovalRequest(request)
          ? request
          : undefined;
      const authorized =
        approvalKind === "plugin"
          ? (!request || pluginRequest !== undefined) &&
            pluginSenderAuth({
              cfg,
              accountId,
              senderId,
              request: pluginRequest,
            })
          : params.isExecAuthorizedSender({ cfg, accountId, senderId });
      return authorized
        ? { authorized: true }
        : {
            authorized: false,
            reason: `❌ You are not authorized to approve ${approvalKind} requests on ${params.channelLabel}.`,
          };
    },
    ...createApproverRestrictedAvailability(params),
  };
}

function createApproverRestrictedAvailability(
  params: ApproverRestrictedNativeApprovalCommonParams &
    Pick<ApproverRestrictedNativeApprovalFlatParams, "hasApprovers">,
): ChannelApprovalCapability {
  return {
    getActionAvailabilityState: ({ cfg, accountId }) =>
      params.hasApprovers({ cfg, accountId }) ? { kind: "enabled" } : { kind: "disabled" },
    describeExecApprovalSetup: params.describeExecApprovalSetup,
    describePluginApprovalSetup: params.describePluginApprovalSetup,
    nativeRuntime: params.nativeRuntime,
    nativeRuntimeAsync: params.nativeRuntimeAsync,
  };
}

type StandardNativeApprovalRouting = Pick<
  ReturnType<typeof createNativeApprovalChannelRouteGates>,
  | "canApprovalPotentiallyRouteToChannel"
  | "canAnyApprovalPotentiallyRouteToChannel"
  | "isNativeApprovalHandlerConfigured"
  | "shouldHandleApprovalRequest"
> & {
  getActionAvailabilityState: NonNullable<ChannelApprovalCapability["getActionAvailabilityState"]>;
  getExecInitiatingSurfaceState: NonNullable<
    ChannelApprovalCapability["getExecInitiatingSurfaceState"]
  >;
  delivery: NonNullable<ChannelApprovalCapability["delivery"]>;
  native: NonNullable<ChannelApprovalCapability["native"]>;
};

type ApproverRestrictedNativeApprovalRoutedParams = {
  /** Standard forwarding-backed native routing assembled inside the capability factory. */
  routing: StandardNativeApprovalRoutingParams;
  /** Channel-owned authorization, including any implicit same-chat fallback marker. */
  authorizeActorAction: NonNullable<ChannelApprovalCapability["authorizeActorAction"]>;
  /** Builds native runtime hooks after the shared routing policy exists. */
  createNativeRuntime?: (
    routing: StandardNativeApprovalRouting,
  ) => ChannelApprovalCapability["nativeRuntime"];
  /** Render hooks for pending and resolved approval payloads. */
  render?: ChannelApprovalCapability["render"];
};

type StandardNativeApprovalRoutingParams = {
  /** Default forwarding mode when top-level approval config omits one. */
  defaultForwardingMode: "session" | "targets" | "both";
  /** Whether the channel transport is available for an account. */
  isTransportEnabled: (params: { cfg: OpenClawConfig; accountId?: string | null }) => boolean;
  /** Lists channel account ids for route and DM availability checks. */
  listAccountIds: (cfg: OpenClawConfig) => readonly string[];
  /** Resolves the channel's default account id. */
  resolveDefaultAccountId: (cfg: OpenClawConfig) => string;
  /** Normalizes a channel-local messaging destination. */
  normalizeTo: (to: string) => string | null | undefined;
  /** Resolves configured native approval recipients. */
  resolveApprovers: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => readonly string[];
  /** Optional origin safety gate, such as requiring approvers for group conversations. */
  isOriginTargetAllowed?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind?: ChannelApprovalKind;
    request: NativeApprovalRequest;
    target: NativeApprovalTarget;
  }) => boolean;
  /** Whether explicit target forwarding participates in exact-match fallback suppression. */
  suppressExplicitTargetFallback?: boolean;
  /** Whether DM-only native delivery should also notify the origin channel. */
  notifyOriginWhenDmOnly?: boolean;
};

function createStandardNativeApprovalRouting(
  channel: string,
  params: StandardNativeApprovalRoutingParams,
): StandardNativeApprovalRouting {
  const targetResolvers = createNativeApprovalMessagingTargetResolvers({
    channel,
    normalizeTo: params.normalizeTo,
  });
  const routeGates = createNativeApprovalChannelRouteGates({
    channel,
    defaultForwardingMode: params.defaultForwardingMode,
    isTransportEnabled: params.isTransportEnabled,
    listAccountIds: params.listAccountIds,
    resolveDefaultAccountId: params.resolveDefaultAccountId,
    normalizeForwardTarget: targetResolvers.normalizeForwardTarget,
    resolveTurnSourceTarget: targetResolvers.resolveTurnSourceTarget,
  });
  const resolveOriginTargetBase = createChannelNativeOriginTargetResolver({
    channel,
    shouldHandleRequest: routeGates.shouldHandleApprovalRequest,
    resolveTurnSourceTarget: targetResolvers.resolveTurnSourceTarget,
    resolveSessionTarget: targetResolvers.resolveSessionTarget,
    normalizeTarget: targetResolvers.normalizeTarget,
  });
  const resolveOriginTarget = (input: Parameters<typeof resolveOriginTargetBase>[0]) => {
    const target = resolveOriginTargetBase(input);
    if (
      !target ||
      (params.isOriginTargetAllowed && !params.isOriginTargetAllowed({ ...input, target }))
    ) {
      return null;
    }
    return target;
  };
  const resolveApproverDmTargets = createChannelApproverDmTargetResolver({
    shouldHandleRequest: routeGates.shouldHandleApprovalRequest,
    resolveApprovers: params.resolveApprovers,
    mapApprover: (approver, input) => {
      const to = params.normalizeTo(approver);
      return to ? { to, accountId: normalizeOptionalString(input.accountId) } : null;
    },
  });
  const shouldSuppressForwardingFallback =
    createNativeApprovalForwardingFallbackSuppressor<NativeApprovalTarget>({
      channel,
      normalizeForwardTarget: targetResolvers.normalizeForwardTarget,
      resolveAccountId: ({ forwardingTarget, request }) =>
        forwardingTarget.accountId ?? normalizeOptionalString(request.request.turnSourceAccountId),
      resolveForwardingTargetForMatch: ({ forwardingTarget, accountId }) => ({
        ...forwardingTarget,
        accountId,
      }),
      isSessionRouteEligible: routeGates.isSessionApprovalEligible,
      isExplicitTargetEligible:
        params.suppressExplicitTargetFallback === false
          ? undefined
          : routeGates.isExplicitTargetEligible,
      resolveOriginTarget,
      resolveApproverDmTargets,
    });
  const availabilityState = (enabled: boolean) =>
    enabled ? ({ kind: "enabled" } as const) : ({ kind: "disabled" } as const);

  return {
    canApprovalPotentiallyRouteToChannel: routeGates.canApprovalPotentiallyRouteToChannel,
    canAnyApprovalPotentiallyRouteToChannel: routeGates.canAnyApprovalPotentiallyRouteToChannel,
    isNativeApprovalHandlerConfigured: routeGates.isNativeApprovalHandlerConfigured,
    shouldHandleApprovalRequest: routeGates.shouldHandleApprovalRequest,
    getActionAvailabilityState: ({ cfg, accountId, approvalKind }) =>
      availabilityState(
        approvalKind
          ? routeGates.canApprovalPotentiallyRouteToChannel({ cfg, accountId, approvalKind })
          : routeGates.canAnyApprovalPotentiallyRouteToChannel({ cfg, accountId }),
      ),
    getExecInitiatingSurfaceState: ({ cfg, accountId }) =>
      availabilityState(
        routeGates.canApprovalPotentiallyRouteToChannel({
          cfg,
          accountId,
          approvalKind: "exec",
        }),
      ),
    delivery: {
      hasConfiguredDmRoute: ({ cfg }) =>
        params.listAccountIds(cfg).some(
          (accountId) =>
            routeGates.canAnyApprovalPotentiallyRouteToChannel({
              cfg,
              accountId,
              nativeSessionOnly: true,
            }) && params.resolveApprovers({ cfg, accountId }).length > 0,
        ),
      shouldSuppressForwardingFallback,
    },
    native: {
      describeDeliveryCapabilities: ({ cfg, accountId, approvalKind, request }) => {
        const input = { cfg, accountId, approvalKind, request };
        const originTarget = resolveOriginTarget(input);
        const approverTargets = resolveApproverDmTargets(input);
        return {
          enabled: Boolean(originTarget) || approverTargets.length > 0,
          preferredSurface: originTarget ? "origin" : "approver-dm",
          supportsOriginSurface: Boolean(originTarget),
          supportsApproverDmSurface: approverTargets.length > 0,
          notifyOriginWhenDmOnly: params.notifyOriginWhenDmOnly ?? true,
        };
      },
      resolveOriginTarget,
      resolveApproverDmTargets,
    },
  };
}

/** Build the canonical approval capability for approver-restricted native delivery channels. */
export function createApproverRestrictedNativeApprovalCapability(
  params: ApproverRestrictedNativeApprovalCommonParams & ApproverRestrictedNativeApprovalFlatParams,
): ChannelApprovalCapability {
  const availabilityState = (enabled: boolean) =>
    enabled ? ({ kind: "enabled" } as const) : ({ kind: "disabled" } as const);
  const normalizePreferredSurface = (
    mode: NativeApprovalDeliveryMode,
  ): NativeApprovalSurface | "both" =>
    mode === "channel" ? "origin" : mode === "dm" ? "approver-dm" : "both";
  const isExecInitiatingSurfaceEnabled = ({
    cfg,
    accountId,
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) =>
    params.hasApprovers({ cfg, accountId }) && params.isNativeDeliveryEnabled({ cfg, accountId });

  return createChannelApprovalCapability({
    ...createApproverRestrictedAuth(params),
    getExecInitiatingSurfaceState: ({ cfg, accountId }) =>
      availabilityState(isExecInitiatingSurfaceEnabled({ cfg, accountId })),
    describeExecApprovalSetup: params.describeExecApprovalSetup,
    describePluginApprovalSetup: params.describePluginApprovalSetup,
    delivery: {
      hasConfiguredDmRoute: ({ cfg }) =>
        params.listAccountIds(cfg).some((accountId) => {
          if (!params.hasApprovers({ cfg, accountId })) {
            return false;
          }
          if (!params.isNativeDeliveryEnabled({ cfg, accountId })) {
            return false;
          }
          const target = params.resolveNativeDeliveryMode({ cfg, accountId });
          return target === "dm" || target === "both";
        }),
      shouldSuppressForwardingFallback: (input: DeliverySuppressionParams) => {
        const channel = normalizeMessageChannel(input.target.channel) ?? input.target.channel;
        if (channel !== params.channel) {
          return false;
        }
        if (params.requireMatchingTurnSourceChannel) {
          const turnSourceChannel = normalizeMessageChannel(
            input.request.request.turnSourceChannel,
          );
          if (turnSourceChannel !== params.channel) {
            return false;
          }
        }
        const resolvedAccountId = params.resolveSuppressionAccountId?.(input);
        const accountId =
          (resolvedAccountId === undefined
            ? input.target.accountId?.trim()
            : resolvedAccountId.trim()) || undefined;
        // Suppress generic forwarding only when this channel's native route can
        // handle the same account; otherwise the fallback is the only delivery path.
        return params.isNativeDeliveryEnabled({ cfg: input.cfg, accountId });
      },
    },
    native:
      params.resolveOriginTarget || params.resolveApproverDmTargets
        ? {
            describeDeliveryCapabilities: ({ cfg, accountId }) => ({
              enabled: isExecInitiatingSurfaceEnabled({ cfg, accountId }),
              preferredSurface: normalizePreferredSurface(
                params.resolveNativeDeliveryMode({ cfg, accountId }),
              ),
              supportsOriginSurface: Boolean(params.resolveOriginTarget),
              supportsApproverDmSurface: Boolean(params.resolveApproverDmTargets),
              notifyOriginWhenDmOnly: params.notifyOriginWhenDmOnly ?? false,
            }),
            resolveOriginTarget: params.resolveOriginTarget,
            resolveApproverDmTargets: params.resolveApproverDmTargets,
          }
        : undefined,
    nativeRuntime: params.nativeRuntime,
  });
}

/** Build approver-restricted native delivery using worker-owned account eligibility. */
export function createApproverRestrictedNativeApprovalCapabilityAsync(
  params: ApproverRestrictedNativeApprovalCommonParams &
    ApproverRestrictedNativeApprovalAsyncParams,
): ChannelApprovalCapability {
  const isEnabled = async (input: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    approvalKind?: ChannelApprovalKind;
  }) => params.hasApprovers(input) && (await params.isNativeDeliveryEnabled(input));
  return createChannelApprovalCapability({
    ...createApproverRestrictedAvailability(params),
    authorizeActorActionAsync: async ({
      cfg,
      accountId,
      senderId,
      approvalKind,
      request,
      sessionDelivery,
    }) => {
      const pluginRequest =
        approvalKind === "plugin" && request && isPluginApprovalRequest(request)
          ? request
          : undefined;
      const authorized =
        approvalKind === "plugin"
          ? (!request || pluginRequest !== undefined) &&
            (await (params.isPluginAuthorizedSender ?? params.isExecAuthorizedSender)({
              cfg,
              accountId,
              senderId,
              request: pluginRequest,
              sessionDelivery,
            }))
          : await params.isExecAuthorizedSender({ cfg, accountId, senderId, sessionDelivery });
      return authorized
        ? { authorized: true }
        : {
            authorized: false,
            reason: `❌ You are not authorized to approve ${approvalKind} requests on ${params.channelLabel}.`,
          };
    },
    getExecInitiatingSurfaceStateAsync: async (input) =>
      (await isEnabled(input)) ? { kind: "enabled" } : { kind: "disabled" },
    delivery: {
      hasConfiguredDmRouteAsync: async ({ cfg }) => {
        for (const accountId of params.listAccountIds(cfg)) {
          if (!(await isEnabled({ cfg, accountId }))) {
            continue;
          }
          const mode = params.resolveNativeDeliveryMode({ cfg, accountId });
          if (mode === "dm" || mode === "both") {
            return true;
          }
        }
        return false;
      },
      shouldSuppressForwardingFallbackAsync: async (input) => {
        const channel = normalizeMessageChannel(input.target.channel) ?? input.target.channel;
        if (
          channel !== params.channel ||
          (params.requireMatchingTurnSourceChannel &&
            normalizeMessageChannel(input.request.request.turnSourceChannel) !== params.channel)
        ) {
          return false;
        }
        const resolvedAccountId = params.resolveSuppressionAccountId?.(input);
        const accountId =
          (resolvedAccountId === undefined
            ? input.target.accountId?.trim()
            : resolvedAccountId.trim()) || undefined;
        return params.isNativeDeliveryEnabled({ cfg: input.cfg, accountId });
      },
    },
    nativeAsync:
      params.resolveOriginTarget || params.resolveApproverDmTargets
        ? {
            describeDeliveryCapabilities: async ({ cfg, accountId, approvalKind }) => {
              const enabled = await isEnabled({ cfg, accountId, approvalKind });
              const mode = params.resolveNativeDeliveryMode({ cfg, accountId });
              return {
                enabled,
                preferredSurface:
                  mode === "channel" ? "origin" : mode === "dm" ? "approver-dm" : "both",
                supportsOriginSurface: Boolean(params.resolveOriginTarget),
                supportsApproverDmSurface: Boolean(params.resolveApproverDmTargets),
                notifyOriginWhenDmOnly: params.notifyOriginWhenDmOnly ?? false,
              };
            },
            resolveOriginTarget: params.resolveOriginTarget,
            resolveApproverDmTargets: params.resolveApproverDmTargets,
          }
        : undefined,
  });
}

/** Build the split approval adapter shape for approver-restricted native channels. */
export function createApproverRestrictedNativeApprovalAdapter(
  params: ApproverRestrictedNativeApprovalCommonParams & ApproverRestrictedNativeApprovalFlatParams,
) {
  return splitChannelApprovalCapability(createApproverRestrictedNativeApprovalCapability(params));
}

/** Assemble a channel approval capability from its auth, delivery, render, and native surfaces. */
export function createChannelApprovalCapability(params: {
  /** Authorizes actors attempting approval actions. */
  authorizeActorAction?: ChannelApprovalCapability["authorizeActorAction"];
  authorizeActorActionAsync?: ChannelApprovalCapability["authorizeActorActionAsync"];
  /** Reports whether approval actions are generally available. */
  getActionAvailabilityState?: ChannelApprovalCapability["getActionAvailabilityState"];
  getActionAvailabilityStateAsync?: ChannelApprovalCapability["getActionAvailabilityStateAsync"];
  /** Reports whether exec approvals can start from the initiating surface. */
  getExecInitiatingSurfaceState?: ChannelApprovalCapability["getExecInitiatingSurfaceState"];
  getExecInitiatingSurfaceStateAsync?: ChannelApprovalCapability["getExecInitiatingSurfaceStateAsync"];
  /** Optional command behavior override for approval replies. */
  resolveApproveCommandBehavior?: ChannelApprovalCapability["resolveApproveCommandBehavior"];
  /** Optional setup copy for unavailable exec approval paths. */
  describeExecApprovalSetup?: ChannelApprovalCapability["describeExecApprovalSetup"];
  /** Optional setup copy for unavailable plugin approval paths. */
  describePluginApprovalSetup?: ChannelApprovalCapability["describePluginApprovalSetup"];
  /** Delivery fallback and DM-route helpers. */
  delivery?: ChannelApprovalCapability["delivery"];
  /** Native runtime hooks for channel-specific approval delivery. */
  nativeRuntime?: ChannelApprovalCapability["nativeRuntime"];
  nativeRuntimeAsync?: ChannelApprovalCapability["nativeRuntimeAsync"];
  /** Render hooks for pending/resolved approval payloads. */
  render?: ChannelApprovalCapability["render"];
  /** Native target/capability discovery hooks. */
  native?: ChannelApprovalCapability["native"];
  nativeAsync?: ChannelApprovalCapability["nativeAsync"];
}): ChannelApprovalCapability {
  const { delivery, nativeRuntime, render, native } = params;
  return {
    authorizeActorAction: params.authorizeActorAction,
    authorizeActorActionAsync: params.authorizeActorActionAsync,
    getActionAvailabilityState: params.getActionAvailabilityState,
    getActionAvailabilityStateAsync: params.getActionAvailabilityStateAsync,
    getExecInitiatingSurfaceState: params.getExecInitiatingSurfaceState,
    getExecInitiatingSurfaceStateAsync: params.getExecInitiatingSurfaceStateAsync,
    resolveApproveCommandBehavior: params.resolveApproveCommandBehavior,
    describeExecApprovalSetup: params.describeExecApprovalSetup,
    describePluginApprovalSetup: params.describePluginApprovalSetup,
    delivery,
    nativeRuntime,
    nativeRuntimeAsync: params.nativeRuntimeAsync,
    render,
    native,
    nativeAsync: params.nativeAsync,
  };
}

/** Split the canonical approval capability into the adapter shape older channel loaders consume. */
export function splitChannelApprovalCapability(capability: ChannelApprovalCapability): {
  auth: {
    authorizeActorAction?: ChannelApprovalCapability["authorizeActorAction"];
    authorizeActorActionAsync?: ChannelApprovalCapability["authorizeActorActionAsync"];
    getActionAvailabilityState?: ChannelApprovalCapability["getActionAvailabilityState"];
    getActionAvailabilityStateAsync?: ChannelApprovalCapability["getActionAvailabilityStateAsync"];
    getExecInitiatingSurfaceState?: ChannelApprovalCapability["getExecInitiatingSurfaceState"];
    getExecInitiatingSurfaceStateAsync?: ChannelApprovalCapability["getExecInitiatingSurfaceStateAsync"];
    resolveApproveCommandBehavior?: ChannelApprovalCapability["resolveApproveCommandBehavior"];
  };
  delivery: ChannelApprovalCapability["delivery"];
  nativeRuntime: ChannelApprovalCapability["nativeRuntime"];
  nativeRuntimeAsync: ChannelApprovalCapability["nativeRuntimeAsync"];
  render: ChannelApprovalCapability["render"];
  native: ChannelApprovalCapability["native"];
  nativeAsync: ChannelApprovalCapability["nativeAsync"];
  describeExecApprovalSetup: ChannelApprovalCapability["describeExecApprovalSetup"];
  describePluginApprovalSetup: ChannelApprovalCapability["describePluginApprovalSetup"];
} {
  return {
    auth: {
      authorizeActorAction: capability.authorizeActorAction,
      authorizeActorActionAsync: capability.authorizeActorActionAsync,
      getActionAvailabilityState: capability.getActionAvailabilityState,
      getActionAvailabilityStateAsync: capability.getActionAvailabilityStateAsync,
      getExecInitiatingSurfaceState: capability.getExecInitiatingSurfaceState,
      getExecInitiatingSurfaceStateAsync: capability.getExecInitiatingSurfaceStateAsync,
      resolveApproveCommandBehavior: capability.resolveApproveCommandBehavior,
    },
    delivery: capability.delivery,
    nativeRuntime: capability.nativeRuntime,
    nativeRuntimeAsync: capability.nativeRuntimeAsync,
    render: capability.render,
    native: capability.native,
    nativeAsync: capability.nativeAsync,
    describeExecApprovalSetup: capability.describeExecApprovalSetup,
    describePluginApprovalSetup: capability.describePluginApprovalSetup,
  };
}

/** @deprecated Use createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutesAsync for worker-owned session reads. */
export function createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutes(
  params: ApproverRestrictedNativeApprovalCommonParams &
    ApproverRestrictedNativeApprovalRoutedParams,
): { capability: ChannelApprovalCapability; routing: StandardNativeApprovalRouting } {
  warnPluginSdkDeprecation({
    family: "approval-session-routing",
    method: "createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutes",
    replacement: "createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutesAsync",
  });
  const routing = createStandardNativeApprovalRouting(params.channel, params.routing);
  return {
    capability: createChannelApprovalCapability({
      authorizeActorAction: params.authorizeActorAction,
      getActionAvailabilityState: routing.getActionAvailabilityState,
      getExecInitiatingSurfaceState: routing.getExecInitiatingSurfaceState,
      describeExecApprovalSetup: params.describeExecApprovalSetup,
      describePluginApprovalSetup: params.describePluginApprovalSetup,
      delivery: routing.delivery,
      native: routing.native,
      nativeRuntime: params.createNativeRuntime?.(routing) ?? params.nativeRuntime,
      render: params.render,
    }),
    routing,
  };
}

type StandardNativeApprovalRoutingAsync = Omit<
  StandardNativeApprovalRouting,
  "shouldHandleApprovalRequest" | "native"
> & {
  shouldHandleApprovalRequest: ReturnType<
    typeof createNativeApprovalChannelRouteGatesAsync
  >["shouldHandleApprovalRequest"];
  nativeAsync: NonNullable<ChannelApprovalCapability["nativeAsync"]>;
};

function createStandardNativeApprovalRoutingAsync(
  channel: string,
  params: StandardNativeApprovalRoutingParams,
): StandardNativeApprovalRoutingAsync {
  const targetResolvers = createNativeApprovalMessagingTargetResolvers({
    channel,
    normalizeTo: params.normalizeTo,
  });
  const routeGates = createNativeApprovalChannelRouteGatesAsync({
    channel,
    defaultForwardingMode: params.defaultForwardingMode,
    isTransportEnabled: params.isTransportEnabled,
    listAccountIds: params.listAccountIds,
    resolveDefaultAccountId: params.resolveDefaultAccountId,
    normalizeForwardTarget: targetResolvers.normalizeForwardTarget,
    resolveTurnSourceTarget: targetResolvers.resolveTurnSourceTarget,
  });
  const resolveOriginTargetBase = createChannelNativeOriginTargetResolverAsync({
    channel,
    shouldHandleRequest: routeGates.shouldHandleApprovalRequest,
    resolveTurnSourceTarget: targetResolvers.resolveTurnSourceTarget,
    resolveSessionTarget: targetResolvers.resolveSessionTarget,
    normalizeTarget: targetResolvers.normalizeTarget,
  });
  const resolveOriginTarget = async (input: Parameters<typeof resolveOriginTargetBase>[0]) => {
    const target = await resolveOriginTargetBase(input);
    if (
      !target ||
      (params.isOriginTargetAllowed && !params.isOriginTargetAllowed({ ...input, target }))
    ) {
      return null;
    }
    return target;
  };
  const resolveApproverDmTargets = createChannelApproverDmTargetResolverAsync({
    shouldHandleRequest: routeGates.shouldHandleApprovalRequest,
    resolveApprovers: params.resolveApprovers,
    mapApprover: (approver, input) => {
      const to = params.normalizeTo(approver);
      return to ? { to, accountId: normalizeOptionalString(input.accountId) } : null;
    },
  });
  const shouldSuppressForwardingFallback =
    createNativeApprovalForwardingFallbackSuppressorAsync<NativeApprovalTarget>({
      channel,
      normalizeForwardTarget: targetResolvers.normalizeForwardTarget,
      resolveAccountId: ({ forwardingTarget, request }) =>
        forwardingTarget.accountId ?? normalizeOptionalString(request.request.turnSourceAccountId),
      resolveForwardingTargetForMatch: ({ forwardingTarget, accountId }) => ({
        ...forwardingTarget,
        accountId,
      }),
      isSessionRouteEligible: routeGates.isSessionApprovalEligible,
      isExplicitTargetEligible:
        params.suppressExplicitTargetFallback === false
          ? undefined
          : routeGates.isExplicitTargetEligible,
      resolveOriginTarget,
      resolveApproverDmTargets,
    });
  const availabilityState = (enabled: boolean) =>
    enabled ? ({ kind: "enabled" } as const) : ({ kind: "disabled" } as const);

  return {
    canApprovalPotentiallyRouteToChannel: routeGates.canApprovalPotentiallyRouteToChannel,
    canAnyApprovalPotentiallyRouteToChannel: routeGates.canAnyApprovalPotentiallyRouteToChannel,
    isNativeApprovalHandlerConfigured: routeGates.isNativeApprovalHandlerConfigured,
    shouldHandleApprovalRequest: routeGates.shouldHandleApprovalRequest,
    getActionAvailabilityState: ({ cfg, accountId, approvalKind }) =>
      availabilityState(
        approvalKind
          ? routeGates.canApprovalPotentiallyRouteToChannel({ cfg, accountId, approvalKind })
          : routeGates.canAnyApprovalPotentiallyRouteToChannel({ cfg, accountId }),
      ),
    getExecInitiatingSurfaceState: ({ cfg, accountId }) =>
      availabilityState(
        routeGates.canApprovalPotentiallyRouteToChannel({
          cfg,
          accountId,
          approvalKind: "exec",
        }),
      ),
    delivery: {
      hasConfiguredDmRoute: ({ cfg }) =>
        params.listAccountIds(cfg).some(
          (accountId) =>
            routeGates.canAnyApprovalPotentiallyRouteToChannel({
              cfg,
              accountId,
              nativeSessionOnly: true,
            }) && params.resolveApprovers({ cfg, accountId }).length > 0,
        ),
      shouldSuppressForwardingFallbackAsync: shouldSuppressForwardingFallback,
    },
    nativeAsync: {
      describeDeliveryCapabilities: async ({ cfg, accountId, approvalKind, request }) => {
        const sessionDelivery = await resolveApprovalRequestSessionDeliveryAsync({ cfg, request });
        const input = { cfg, accountId, approvalKind, request, sessionDelivery };
        const [originTarget, approverTargets] = await Promise.all([
          resolveOriginTarget(input),
          resolveApproverDmTargets(input),
        ]);
        return {
          enabled: Boolean(originTarget) || approverTargets.length > 0,
          preferredSurface: originTarget ? "origin" : "approver-dm",
          supportsOriginSurface: Boolean(originTarget),
          supportsApproverDmSurface: approverTargets.length > 0,
          notifyOriginWhenDmOnly: params.notifyOriginWhenDmOnly ?? true,
        };
      },
      resolveOriginTarget,
      resolveApproverDmTargets,
    },
  };
}

/** Build forwarding routes with worker-owned session and account resolution. */
export function createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutesAsync(
  params: ApproverRestrictedNativeApprovalCommonParams &
    Omit<ApproverRestrictedNativeApprovalRoutedParams, "createNativeRuntime"> & {
      createNativeRuntime?: (
        routing: StandardNativeApprovalRoutingAsync,
      ) => ChannelApprovalCapability["nativeRuntimeAsync"];
    },
): { capability: ChannelApprovalCapability; routing: StandardNativeApprovalRoutingAsync } {
  const routing = createStandardNativeApprovalRoutingAsync(params.channel, params.routing);
  return {
    capability: createChannelApprovalCapability({
      authorizeActorAction: params.authorizeActorAction,
      getActionAvailabilityState: routing.getActionAvailabilityState,
      getExecInitiatingSurfaceState: routing.getExecInitiatingSurfaceState,
      describeExecApprovalSetup: params.describeExecApprovalSetup,
      describePluginApprovalSetup: params.describePluginApprovalSetup,
      delivery: routing.delivery,
      nativeAsync: routing.nativeAsync,
      nativeRuntimeAsync: params.createNativeRuntime?.(routing) ?? params.nativeRuntimeAsync,
      render: params.render,
    }),
    routing,
  };
}
