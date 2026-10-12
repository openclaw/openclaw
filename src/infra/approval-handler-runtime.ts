// Runtime contracts for approval handlers used by execution requests.
import type {
  ChannelApprovalCapability,
  ChannelApprovalNativeAdapter,
  ChannelApprovalNativeAdapterAsync,
} from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { canChannelEnforcePluginReviewerPolicy } from "./approval-channel-policy-support.js";
import {
  CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
  createLazyChannelApprovalNativeRuntimeAdapter,
} from "./approval-handler-adapter-runtime.js";
import type {
  ApprovalRequest,
  ApprovalResolved,
  ChannelApprovalCapabilityHandlerContext,
  ChannelApprovalKind,
  ChannelApprovalNativeRuntimeAdapter,
  ChannelApprovalNativeRuntimeAdapterAsync,
  ChannelApprovalNativeRuntimeSpec,
  ChannelApprovalNativeRuntimeSpecAsync,
} from "./approval-handler-runtime-types.js";
import type {
  ChannelNativeApprovalDeliveryCallbacks,
  ChannelNativeApprovalTransportSpec,
} from "./approval-native-runtime-types.js";
import { createChannelNativeApprovalRuntimeAsync } from "./approval-native-runtime.js";
import { normalizeApprovalRequest } from "./approval-types.js";
import {
  buildExpiredApprovalView,
  buildPendingApprovalView,
  buildResolvedApprovalView,
} from "./approval-view-model.js";
import type {
  ExpiredApprovalView,
  PendingApprovalView,
  ResolvedApprovalView,
} from "./approval-view-model.types.js";
import type { ExecApprovalChannelRuntime } from "./exec-approval-channel-runtime.js";

export type {
  ApprovalActionView,
  ApprovalMetadataView,
  ApprovalViewModel,
  ExecApprovalExpiredView,
  ExecApprovalPendingView,
  ExecApprovalResolvedView,
  ExpiredApprovalView,
  PendingApprovalView,
  PluginApprovalExpiredView,
  PluginApprovalPendingView,
  PluginApprovalResolvedView,
  ResolvedApprovalView,
} from "./approval-view-model.types.js";
export {
  CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
  createLazyChannelApprovalNativeRuntimeAdapter,
};
export type {
  ChannelApprovalCapabilityHandlerContext,
  ChannelApprovalNativeAvailabilityAdapter,
  ChannelApprovalNativeFinalAction,
  ChannelApprovalNativeInteractionAdapter,
  ChannelApprovalNativeObserveAdapter,
  ChannelApprovalNativePresentationAdapter,
  ChannelApprovalNativeRuntimeAdapter,
  ChannelApprovalNativeRuntimeAdapterAsync,
  ChannelApprovalNativeRuntimeSpec,
  ChannelApprovalNativeRuntimeSpecAsync,
  ChannelApprovalNativeTransportAdapter,
} from "./approval-handler-runtime-types.js";

export type ChannelApprovalHandler<
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
> = ExecApprovalChannelRuntime<TRequest, TResolved>;

type WrappedPendingEntry = {
  entry: unknown;
  binding?: unknown;
};

type ActiveApprovalEntries = {
  request: ApprovalRequest;
  approvalKind: ChannelApprovalKind;
  entries: WrappedPendingEntry[];
};

type WrappedPendingContent = {
  view: PendingApprovalView;
  payload: unknown;
};

/** Adapts a typed channel native approval spec with synchronous availability. */
export function createChannelApprovalNativeRuntimeAdapter<
  TPendingPayload,
  TPreparedTarget,
  TPendingEntry,
  TBinding = unknown,
  TFinalPayload = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
  TResolvedView extends ResolvedApprovalView = ResolvedApprovalView,
  TExpiredView extends ExpiredApprovalView = ExpiredApprovalView,
>(
  spec: ChannelApprovalNativeRuntimeSpec<
    TPendingPayload,
    TPreparedTarget,
    TPendingEntry,
    TBinding,
    TFinalPayload,
    TPendingView,
    TResolvedView,
    TExpiredView
  >,
): ChannelApprovalNativeRuntimeAdapter<
  TPendingPayload,
  TPreparedTarget,
  TPendingEntry,
  TBinding,
  TFinalPayload
> {
  return {
    ...createChannelApprovalNativeRuntimeAdapterAsync(spec),
    availability: spec.availability,
  };
}

/** Adapts a strongly typed channel native approval spec into the erased runtime contract. */
export function createChannelApprovalNativeRuntimeAdapterAsync<
  TPendingPayload,
  TPreparedTarget,
  TPendingEntry,
  TBinding = unknown,
  TFinalPayload = unknown,
  TPendingView extends PendingApprovalView = PendingApprovalView,
  TResolvedView extends ResolvedApprovalView = ResolvedApprovalView,
  TExpiredView extends ExpiredApprovalView = ExpiredApprovalView,
>(
  spec: ChannelApprovalNativeRuntimeSpecAsync<
    TPendingPayload,
    TPreparedTarget,
    TPendingEntry,
    TBinding,
    TFinalPayload,
    TPendingView,
    TResolvedView,
    TExpiredView
  >,
): ChannelApprovalNativeRuntimeAdapterAsync<
  TPendingPayload,
  TPreparedTarget,
  TPendingEntry,
  TBinding,
  TFinalPayload
> {
  const adapter: ChannelApprovalNativeRuntimeAdapterAsync<
    TPendingPayload,
    TPreparedTarget,
    TPendingEntry,
    TBinding,
    TFinalPayload
  > = {
    ...(spec.eventKinds ? { eventKinds: spec.eventKinds } : {}),
    ...(spec.resolveApprovalKind ? { resolveApprovalKind: spec.resolveApprovalKind } : {}),
    availability: {
      isConfigured: spec.availability.isConfigured,
      shouldHandle: spec.availability.shouldHandle,
    },
    presentation: {
      buildPendingPayload: async (params) =>
        await spec.presentation.buildPendingPayload(params as never),
      buildResolvedResult: async (params) =>
        await spec.presentation.buildResolvedResult(params as never),
      buildExpiredResult: async (params) =>
        await spec.presentation.buildExpiredResult(params as never),
    },
    transport: {
      prepareTarget: async (params) => await spec.transport.prepareTarget(params as never),
      deliverPending: async (params) => await spec.transport.deliverPending(params as never),
    },
  };
  if (spec.transport.updateEntry) {
    adapter.transport.updateEntry = async (params) => await spec.transport.updateEntry?.(params);
  }
  if (spec.transport.deleteEntry) {
    adapter.transport.deleteEntry = async (params) => await spec.transport.deleteEntry?.(params);
  }
  if (spec.interactions) {
    const interactions: NonNullable<typeof adapter.interactions> = {};
    if (spec.interactions.bindPending) {
      interactions.bindPending = async (params) =>
        (await spec.interactions!.bindPending!(params as never)) ?? null;
    }
    if (spec.interactions.unbindPending) {
      interactions.unbindPending = async (params) =>
        await spec.interactions?.unbindPending?.(params);
    }
    if (spec.interactions.clearPendingActions) {
      interactions.clearPendingActions = async (params) =>
        await spec.interactions?.clearPendingActions?.(params);
    }
    if (spec.interactions.cancelDelivered) {
      interactions.cancelDelivered = async (params) =>
        await spec.interactions?.cancelDelivered?.(params);
    }
    adapter.interactions = interactions;
  }
  if (spec.observe) {
    const observe: NonNullable<typeof adapter.observe> = {};
    if (spec.observe.onDeliveryError) {
      observe.onDeliveryError = (params) => spec.observe?.onDeliveryError?.(params as never);
    }
    if (spec.observe.onDuplicateSkipped) {
      observe.onDuplicateSkipped = (params) => spec.observe?.onDuplicateSkipped?.(params as never);
    }
    if (spec.observe.onDelivered) {
      observe.onDelivered = (params) => spec.observe?.onDelivered?.(params as never);
    }
    if (spec.observe.onFinalized) {
      observe.onFinalized = (params) => spec.observe?.onFinalized?.(params);
    }
    adapter.observe = observe;
  }
  return adapter;
}

type ChannelApprovalHandlerRuntimeSpec<TRequest extends ApprovalRequest> = {
  label: string;
  clientDisplayName: string;
  cfg: OpenClawConfig;
  gatewayUrl?: string;
  eventKinds?: readonly ChannelApprovalKind[];
  channel?: string;
  channelLabel?: string;
  accountId?: string | null;
  nativeAdapter?: ChannelApprovalNativeAdapter | null;
  /** @deprecated Trusted compatibility override; omit to derive ownership from the payload. */
  resolveApprovalKind?: (request: TRequest) => ChannelApprovalKind;
  isConfigured: () => boolean;
  shouldHandle: (request: TRequest) => boolean;
  nowMs?: () => number;
};

type ChannelApprovalHandlerContentSpec<
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
> = {
  buildPendingContent: (params: {
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    nowMs: number;
  }) => TPendingContent | Promise<TPendingContent>;
};

type ChannelApprovalHandlerLifecycleSpec<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
> = ChannelNativeApprovalDeliveryCallbacks<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest
> & {
  finalizeResolved: (params: {
    request: TRequest;
    resolved: TResolved;
    entries: TPendingEntry[];
  }) => Promise<void>;
  finalizeExpired?: (params: { request: TRequest; entries: TPendingEntry[] }) => Promise<void>;
  onStopped?: () => Promise<void> | void;
};

/**
 * Adapter contract used by core to run a channel's native approval delivery lifecycle.
 */
export type ChannelApprovalHandlerAdapter<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
> = {
  runtime: ChannelApprovalHandlerRuntimeSpec<TRequest>;
  content: ChannelApprovalHandlerContentSpec<TPendingContent, TRequest>;
  transport: ChannelNativeApprovalTransportSpec<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest
  >;
  lifecycle: ChannelApprovalHandlerLifecycleSpec<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest,
    TResolved
  >;
};

type ChannelApprovalHandlerAdapterAsync<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
> = Omit<
  ChannelApprovalHandlerAdapter<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest,
    TResolved
  >,
  "runtime"
> & {
  runtime: Omit<
    ChannelApprovalHandlerRuntimeSpec<TRequest>,
    "isConfigured" | "shouldHandle" | "nativeAdapter"
  > & {
    nativeAdapter?: ChannelApprovalNativeAdapter | ChannelApprovalNativeAdapterAsync | null;
    isConfigured: () => boolean | Promise<boolean>;
    shouldHandle: (request: TRequest) => boolean | Promise<boolean>;
  };
};

/** Creates a channel approval handler with synchronous availability callbacks. */
export function createChannelApprovalHandler<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
>(
  adapter: ChannelApprovalHandlerAdapter<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest,
    TResolved
  >,
): ChannelApprovalHandler<TRequest, TResolved> {
  return createChannelApprovalHandlerAsync(adapter);
}

/** Creates the shared approval handler runtime from channel-specific content and transport hooks. */
function createChannelApprovalHandlerAsync<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
>(
  adapter: ChannelApprovalHandlerAdapterAsync<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest,
    TResolved
  >,
): ChannelApprovalHandler<TRequest, TResolved> {
  return createChannelNativeApprovalRuntimeAsync<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest,
    TResolved
  >({
    label: adapter.runtime.label,
    clientDisplayName: adapter.runtime.clientDisplayName,
    cfg: adapter.runtime.cfg,
    gatewayUrl: adapter.runtime.gatewayUrl,
    eventKinds: adapter.runtime.eventKinds,
    channel: adapter.runtime.channel,
    channelLabel: adapter.runtime.channelLabel,
    accountId: adapter.runtime.accountId,
    nativeAdapter: adapter.runtime.nativeAdapter,
    ...(adapter.runtime.resolveApprovalKind
      ? { resolveApprovalKind: adapter.runtime.resolveApprovalKind }
      : {}),
    isConfigured: adapter.runtime.isConfigured,
    shouldHandle: adapter.runtime.shouldHandle,
    nowMs: adapter.runtime.nowMs,
    buildPendingContent: adapter.content.buildPendingContent,
    prepareTarget: adapter.transport.prepareTarget,
    deliverTarget: adapter.transport.deliverTarget,
    onDeliveryError: adapter.lifecycle.onDeliveryError,
    onDuplicateSkipped: adapter.lifecycle.onDuplicateSkipped,
    onDelivered: adapter.lifecycle.onDelivered,
    finalizeResolved: adapter.lifecycle.finalizeResolved,
    finalizeExpired: adapter.lifecycle.finalizeExpired,
    onStopped: adapter.lifecycle.onStopped,
  });
}

/** Builds a shared approval handler from a plugin approval capability, or null when unsupported. */
export async function createChannelApprovalHandlerFromCapability(params: {
  capability?: Pick<
    ChannelApprovalCapability,
    | "native"
    | "nativeAsync"
    | "nativeRuntime"
    | "nativeRuntimeAsync"
    | "supportsScopedPluginApprovalApprovers"
  > | null;
  label: string;
  clientDisplayName: string;
  channel: string;
  channelLabel: string;
  cfg: OpenClawConfig;
  accountId?: string | null;
  gatewayUrl?: string;
  context?: unknown;
  nowMs?: () => number;
}): Promise<ChannelApprovalHandler | null> {
  const nativeRuntime = params.capability?.nativeRuntimeAsync ?? params.capability?.nativeRuntime;
  if (!nativeRuntime) {
    return null;
  }
  const log = createSubsystemLogger(params.label);
  const activeEntries = new Map<string, ActiveApprovalEntries>();
  let stopped = false;
  const resolveApprovalKind = (request: ApprovalRequest): ChannelApprovalKind => {
    const normalizedRequest = normalizeApprovalRequest(request);
    return nativeRuntime.resolveApprovalKind?.(normalizedRequest) ?? normalizedRequest.approvalKind;
  };
  const baseContext: ChannelApprovalCapabilityHandlerContext = {
    cfg: params.cfg,
    accountId: params.accountId,
    gatewayUrl: params.gatewayUrl,
    context: params.context,
  };
  const pendingContext = <T extends { pendingContent: WrappedPendingContent }>({
    pendingContent,
    ...context
  }: T) => ({
    ...baseContext,
    ...context,
    view: pendingContent.view,
    pendingPayload: pendingContent.payload,
  });
  const finalize = async (
    request: ApprovalRequest,
    entries: WrappedPendingEntry[],
    outcome: { phase: "resolved"; resolved: ApprovalResolved } | { phase: "expired" },
  ): Promise<void> => {
    const active = activeEntries.get(request.id)?.entries ?? entries;
    activeEntries.delete(request.id);
    const approvalKind = resolveApprovalKind(request);
    let buildResult: (
      entry: unknown,
    ) => ReturnType<ChannelApprovalNativeRuntimeAdapter["presentation"]["buildResolvedResult"]>;
    if (outcome.phase === "resolved") {
      const view = buildResolvedApprovalView(request, outcome.resolved);
      buildResult = (entry) =>
        nativeRuntime.presentation.buildResolvedResult({
          ...baseContext,
          request,
          resolved: outcome.resolved,
          view,
          entry,
        });
    } else {
      const view = buildExpiredApprovalView(request);
      buildResult = (entry) =>
        nativeRuntime.presentation.buildExpiredResult({
          ...baseContext,
          request,
          view,
          entry,
        });
    }
    for (const wrapped of active) {
      try {
        const entryContext = { ...baseContext, entry: wrapped.entry, phase: outcome.phase };
        if (wrapped.binding !== undefined) {
          await nativeRuntime.interactions?.unbindPending?.({
            ...baseContext,
            entry: wrapped.entry,
            binding: wrapped.binding,
            request,
            approvalKind,
          });
        }
        const result = await buildResult(wrapped.entry);
        switch (result.kind) {
          case "update":
            await nativeRuntime.transport.updateEntry?.({
              ...entryContext,
              request,
              approvalKind,
              payload: result.payload,
            });
            break;
          case "delete":
            await nativeRuntime.transport.deleteEntry?.(entryContext);
            break;
          case "clear-actions":
            await nativeRuntime.interactions?.clearPendingActions?.(entryContext);
            break;
          case "leave":
            break;
        }
      } catch (error) {
        log.error(
          `failed to finalize ${outcome.phase} native approval entry ` +
            `approval=${request.id}: ${String(error)}`,
        );
      }
    }
    nativeRuntime.observe?.onFinalized?.({
      ...baseContext,
      request,
      approvalKind,
      phase: outcome.phase,
    });
  };
  return createChannelApprovalHandlerAsync<WrappedPendingEntry, unknown, WrappedPendingContent>({
    runtime: {
      label: params.label,
      clientDisplayName: params.clientDisplayName,
      channel: params.channel,
      channelLabel: params.channelLabel,
      cfg: params.cfg,
      accountId: params.accountId,
      gatewayUrl: params.gatewayUrl,
      eventKinds: nativeRuntime.eventKinds,
      nativeAdapter: params.capability?.nativeAsync ?? params.capability?.native,
      ...(nativeRuntime.resolveApprovalKind
        ? { resolveApprovalKind: nativeRuntime.resolveApprovalKind }
        : {}),
      isConfigured: () => nativeRuntime.availability.isConfigured(baseContext),
      shouldHandle: (request) => {
        const approvalKind = resolveApprovalKind(request);
        if (
          approvalKind === "plugin" &&
          !canChannelEnforcePluginReviewerPolicy(params.cfg, params.channel, params.capability)
        ) {
          return false;
        }
        return nativeRuntime.availability.shouldHandle({
          ...baseContext,
          request,
          approvalKind,
        });
      },
      nowMs: params.nowMs,
    },
    content: {
      buildPendingContent: async ({ request, approvalKind, nowMs }) => {
        const view = buildPendingApprovalView(request);
        return {
          view,
          payload: await nativeRuntime.presentation.buildPendingPayload({
            ...baseContext,
            request,
            approvalKind,
            nowMs,
            view,
          }),
        };
      },
    },
    transport: {
      prepareTarget: async (target) =>
        await nativeRuntime.transport.prepareTarget(pendingContext(target)),
      deliverTarget: async (target) => {
        const { request, approvalKind, pendingContent } = target;
        const entry = await nativeRuntime.transport.deliverPending(pendingContext(target));
        if (!entry) {
          return null;
        }
        const entryContext = { ...baseContext, entry, request, approvalKind };
        // Stop may race delivery or binding. Never bind after stop, and clean up
        // unbound delivery effects through cancelDelivered rather than unbindPending.
        const binding = stopped
          ? undefined
          : await nativeRuntime.interactions?.bindPending?.({
              ...entryContext,
              view: pendingContent.view,
              pendingPayload: pendingContent.payload,
            });
        if (stopped) {
          if (binding !== undefined && binding !== null) {
            await nativeRuntime.interactions?.unbindPending?.({
              ...entryContext,
              binding,
            });
          } else {
            await nativeRuntime.interactions?.cancelDelivered?.(entryContext);
          }
          return null;
        }
        const wrapped: WrappedPendingEntry = {
          entry,
          ...(binding === undefined || binding === null ? {} : { binding }),
        };
        const activeRequest = activeEntries.get(request.id) ?? {
          request,
          approvalKind,
          entries: [],
        };
        activeRequest.entries.push(wrapped);
        activeEntries.set(request.id, activeRequest);
        return wrapped;
      },
    },
    lifecycle: {
      onDeliveryError: (target) => {
        nativeRuntime.observe?.onDeliveryError?.(pendingContext(target));
      },
      onDuplicateSkipped: (target) => {
        nativeRuntime.observe?.onDuplicateSkipped?.(pendingContext(target));
      },
      onDelivered: (target) => {
        nativeRuntime.observe?.onDelivered?.({
          ...pendingContext(target),
          entry: target.entry.entry,
        });
      },
      finalizeResolved: ({ request, resolved, entries }) =>
        finalize(request, entries, { phase: "resolved", resolved }),
      finalizeExpired: ({ request, entries }) => finalize(request, entries, { phase: "expired" }),
      onStopped: async () => {
        stopped = true;
        for (const activeRequest of activeEntries.values()) {
          if (!nativeRuntime.interactions?.unbindPending) {
            continue;
          }
          for (const wrapped of activeRequest.entries) {
            if (wrapped.binding === undefined) {
              continue;
            }
            try {
              await nativeRuntime.interactions.unbindPending({
                ...baseContext,
                entry: wrapped.entry,
                binding: wrapped.binding,
                request: activeRequest.request,
                approvalKind: activeRequest.approvalKind,
              });
            } catch (error) {
              log.error(
                `failed to unbind stopped native approval entry ` +
                  `approval=${activeRequest.request.id}: ${String(error)}`,
              );
            }
          }
        }
        activeEntries.clear();
      },
    },
  });
}
