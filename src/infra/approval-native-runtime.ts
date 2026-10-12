// Creates channel-native approval runtimes and delivery flows.
import type {
  ChannelApprovalNativeAdapter,
  ChannelApprovalNativeAdapterAsync,
} from "../channels/plugins/approval-native.types.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { getGatewayNativeApprovalRuntime } from "./approval-gateway-runtime-context.js";
import {
  resolveChannelNativeApprovalDeliveryPlan,
  type ChannelApprovalNativePlannedTarget,
  type ChannelApprovalNativeDeliveryPlan,
} from "./approval-native-delivery.js";
import { createApprovalNativeRouteReporter } from "./approval-native-route-coordinator.js";
import type {
  ChannelNativeApprovalDeliveryCallbacks,
  ChannelNativeApprovalTransportSpec,
} from "./approval-native-runtime-types.js";
import { classifyApprovalRequestChannelRoute } from "./approval-request-account-binding.js";
import type {
  ApprovalRequestInput,
  ApprovalResolved,
  ChannelApprovalKind,
  NormalizedApprovalRequest,
} from "./approval-types.js";
import {
  createExecApprovalChannelRuntime,
  type ExecApprovalChannelRuntime,
  type ExecApprovalChannelRuntimeAdapter,
  type ExecApprovalChannelRuntimeAdapterAsync,
} from "./exec-approval-channel-runtime.js";

type ApprovalRequest = ApprovalRequestInput;

type ChannelNativeApprovalRuntimeAdapter<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
> = Omit<
  ExecApprovalChannelRuntimeAdapterAsync<TPendingEntry, TRequest, TResolved>,
  "deliverRequested"
> &
  ChannelNativeApprovalTransportSpec<TPendingEntry, TPreparedTarget, TPendingContent, TRequest> &
  ChannelNativeApprovalDeliveryCallbacks<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest
  > & {
    channel?: string;
    channelLabel?: string;
    accountId?: string | null;
    nativeAdapter?: ChannelApprovalNativeAdapter | ChannelApprovalNativeAdapterAsync | null;
    /** @deprecated Trusted compatibility override; omit to derive ownership from the payload. */
    resolveApprovalKind?: (request: TRequest) => ChannelApprovalKind;
    buildPendingContent: (params: {
      request: TRequest;
      approvalKind: ChannelApprovalKind;
      nowMs: number;
    }) => TPendingContent | Promise<TPendingContent>;
    onStopped?: () => Promise<void> | void;
  };

/** Creates a channel-native approval runtime with synchronous availability callbacks. */
export function createChannelNativeApprovalRuntime<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
>(
  adapter: Omit<
    ChannelNativeApprovalRuntimeAdapter<
      TPendingEntry,
      TPreparedTarget,
      TPendingContent,
      TRequest,
      TResolved
    >,
    "isConfigured" | "shouldHandle" | "nativeAdapter"
  > &
    Pick<
      ExecApprovalChannelRuntimeAdapter<TPendingEntry, TRequest, TResolved>,
      "isConfigured" | "shouldHandle"
    > & { nativeAdapter?: ChannelApprovalNativeAdapter | null },
): ExecApprovalChannelRuntime<TRequest, TResolved> {
  return createChannelNativeApprovalRuntimeAsync(adapter);
}

/** Creates the shared gateway approval runtime backed by channel-native delivery hooks. */
export function createChannelNativeApprovalRuntimeAsync<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
>(
  adapter: ChannelNativeApprovalRuntimeAdapter<
    TPendingEntry,
    TPreparedTarget,
    TPendingContent,
    TRequest,
    TResolved
  >,
): ExecApprovalChannelRuntime<TRequest, TResolved> {
  const nowMs = adapter.nowMs ?? Date.now;
  const handledEventKinds = new Set<ChannelApprovalKind>(adapter.eventKinds ?? ["exec"]);
  const gatewayRuntime = getGatewayNativeApprovalRuntime();
  const createRouteReporter =
    gatewayRuntime?.routeCoordinator.createReporter ?? createApprovalNativeRouteReporter;
  const routeReporter = createRouteReporter({
    handledKinds: handledEventKinds,
    channel: adapter.channel,
    channelLabel: adapter.channelLabel,
    accountId: adapter.accountId,
    // SAFETY: the route coordinator receives only normalized requests from this runtime.
    shouldHandle: (request) => adapter.shouldHandle(request as NormalizedApprovalRequest<TRequest>),
    classifyRoute: (request) =>
      classifyApprovalRequestChannelRoute({
        cfg: adapter.cfg,
        request,
        channel: adapter.channel ?? "",
      }),
    requestGateway: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      if (gatewayRuntime) {
        if (method !== "send") {
          throw new Error(`native approval route cannot dispatch ${method}`);
        }
        return await gatewayRuntime.requestRoute<T>(method, params);
      }
      const { callGatewayLeastPrivilege } = await import("../gateway/call.js");
      return await callGatewayLeastPrivilege<T>({
        config: adapter.cfg,
        ...(adapter.gatewayUrl ? { url: adapter.gatewayUrl } : {}),
        method,
        params,
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      });
    },
  });

  const finalize =
    <TParams extends { request: TRequest }>(run: (params: TParams) => Promise<void> | undefined) =>
    async (params: TParams): Promise<void> => {
      try {
        await run(params);
      } finally {
        routeReporter.completeRequest(params.request.id);
      }
    };

  const runtime = createExecApprovalChannelRuntime<TPendingEntry, TRequest, TResolved>({
    label: adapter.label,
    clientDisplayName: adapter.clientDisplayName,
    cfg: adapter.cfg,
    gatewayUrl: adapter.gatewayUrl,
    eventKinds: adapter.eventKinds,
    isConfigured: adapter.isConfigured,
    shouldHandle: async (request) => {
      const approvalKind = adapter.resolveApprovalKind?.(request) ?? request.approvalKind;
      const selection = await routeReporter.selectRequest({
        approvalKind,
        request,
      });
      if (selection.kind === "selected") {
        return true;
      }
      void routeReporter.reportSkipped({
        approvalKind,
        request,
        reason: selection.kind === "selector-error" ? "ineligible" : selection.kind,
      });
      if (selection.kind === "selector-error") {
        throw selection.error;
      }
      return false;
    },
    finalizeResolved: finalize((params) => adapter.finalizeResolved(params)),
    finalizeExpired: adapter.finalizeExpired
      ? finalize((params) => adapter.finalizeExpired?.(params))
      : undefined,
    onStopped: adapter.onStopped,
    beforeGatewayClientStart: () => {
      routeReporter.start();
    },
    nowMs,
    deliverRequested: async (request) => {
      const approvalKind = adapter.resolveApprovalKind?.(request) ?? request.approvalKind;
      let deliveryPlan: ChannelApprovalNativeDeliveryPlan = {
        targets: [],
        originTarget: null,
        notifyOriginWhenDmOnly: false,
      };
      let deliveredTargets: ChannelApprovalNativePlannedTarget[] = [];
      try {
        const pendingContent = await adapter.buildPendingContent({
          request,
          approvalKind,
          nowMs: nowMs(),
        });
        const plannedDelivery = await resolveChannelNativeApprovalDeliveryPlan({
          cfg: adapter.cfg,
          accountId: adapter.accountId,
          approvalKind,
          request,
          adapter: adapter.nativeAdapter,
        });
        const deliveredKeys = new Set<string>();
        const entries: TPendingEntry[] = [];
        const completedTargets: ChannelApprovalNativePlannedTarget[] = [];
        for (const plannedTarget of plannedDelivery.targets) {
          const target = { plannedTarget, request, approvalKind, pendingContent };
          try {
            const preparedTarget = await adapter.prepareTarget({ ...target });
            if (!preparedTarget) {
              continue;
            }
            // Different surfaces can converge on the same prepared message target.
            if (deliveredKeys.has(preparedTarget.dedupeKey)) {
              adapter.onDuplicateSkipped?.({ ...target, preparedTarget });
              continue;
            }
            const entry = await adapter.deliverTarget({
              ...target,
              preparedTarget: preparedTarget.target,
            });
            if (!entry) {
              continue;
            }
            deliveredKeys.add(preparedTarget.dedupeKey);
            entries.push(entry);
            completedTargets.push(plannedTarget);
            adapter.onDelivered?.({ ...target, preparedTarget, entry });
          } catch (error) {
            adapter.onDeliveryError?.({ ...target, error });
          }
        }
        deliveryPlan = plannedDelivery;
        deliveredTargets = completedTargets;
        return entries;
      } finally {
        await routeReporter.reportDelivery({
          approvalKind,
          request,
          deliveryPlan,
          deliveredTargets,
        });
      }
    },
  });

  return {
    ...runtime,
    async start() {
      try {
        await runtime.start();
      } catch (error) {
        await routeReporter.stop();
        throw error;
      }
    },
    async stop() {
      await runtime.stop();
      await routeReporter.stop();
    },
  };
}
