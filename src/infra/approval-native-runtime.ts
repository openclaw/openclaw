import type {
  ChannelApprovalKind,
  ChannelApprovalNativeAdapter,
  ChannelApprovalNativeTarget,
} from "../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveChannelNativeApprovalDeliveryPlan,
  type ChannelApprovalNativePlannedTarget,
} from "./approval-native-delivery.js";
import {
  createExecApprovalChannelRuntime,
  type ExecApprovalChannelRuntime,
  type ExecApprovalChannelRuntimeAdapter,
} from "./exec-approval-channel-runtime.js";
import type { ExecApprovalResolved } from "./exec-approvals.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalResolved } from "./plugin-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type ApprovalResolved = ExecApprovalResolved | PluginApprovalResolved;

export type PreparedChannelNativeApprovalTarget<TPreparedTarget> = {
  dedupeKey: string;
  target: TPreparedTarget;
};

function buildTargetKey(target: ChannelApprovalNativeTarget): string {
  return `${target.to}:${target.threadId == null ? "" : String(target.threadId)}`;
}

export async function deliverApprovalRequestViaChannelNativePlan<
  TPreparedTarget,
  TPendingEntry,
  TRequest extends ApprovalRequest = ApprovalRequest,
>(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind: ChannelApprovalKind;
  request: TRequest;
  adapter?: ChannelApprovalNativeAdapter | null;
  sendOriginNotice?: (params: {
    originTarget: ChannelApprovalNativeTarget;
    request: TRequest;
  }) => Promise<void>;
  prepareTarget: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    request: TRequest;
  }) =>
    | PreparedChannelNativeApprovalTarget<TPreparedTarget>
    | null
    | Promise<PreparedChannelNativeApprovalTarget<TPreparedTarget> | null>;
  deliverTarget: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: TPreparedTarget;
    request: TRequest;
  }) => TPendingEntry | null | Promise<TPendingEntry | null>;
  onOriginNoticeError?: (params: {
    error: unknown;
    originTarget: ChannelApprovalNativeTarget;
    request: TRequest;
  }) => void;
  onDeliveryError?: (params: {
    error: unknown;
    plannedTarget: ChannelApprovalNativePlannedTarget;
    request: TRequest;
  }) => void;
  onDuplicateSkipped?: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
    request: TRequest;
  }) => void;
  onDelivered?: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
    request: TRequest;
    entry: TPendingEntry;
  }) => void;
}): Promise<TPendingEntry[]> {
  const deliveryPlan = await resolveChannelNativeApprovalDeliveryPlan({
    cfg: params.cfg,
    accountId: params.accountId,
    approvalKind: params.approvalKind,
    request: params.request,
    adapter: params.adapter,
  });

  const originTargetKey = deliveryPlan.originTarget
    ? buildTargetKey(deliveryPlan.originTarget)
    : null;
  const plannedTargetKeys = new Set(
    deliveryPlan.targets.map((plannedTarget) => buildTargetKey(plannedTarget.target)),
  );

  if (
    deliveryPlan.notifyOriginWhenDmOnly &&
    deliveryPlan.originTarget &&
    (originTargetKey == null || !plannedTargetKeys.has(originTargetKey))
  ) {
    try {
      await params.sendOriginNotice?.({
        originTarget: deliveryPlan.originTarget,
        request: params.request,
      });
    } catch (error) {
      params.onOriginNoticeError?.({
        error,
        originTarget: deliveryPlan.originTarget,
        request: params.request,
      });
    }
  }

  const deliveredKeys = new Set<string>();
  const pendingEntries: TPendingEntry[] = [];
  for (const plannedTarget of deliveryPlan.targets) {
    try {
      const preparedTarget = await params.prepareTarget({
        plannedTarget,
        request: params.request,
      });
      if (!preparedTarget) {
        continue;
      }
      if (deliveredKeys.has(preparedTarget.dedupeKey)) {
        params.onDuplicateSkipped?.({
          plannedTarget,
          preparedTarget,
          request: params.request,
        });
        continue;
      }

      const entry = await params.deliverTarget({
        plannedTarget,
        preparedTarget: preparedTarget.target,
        request: params.request,
      });
      if (!entry) {
        continue;
      }

      deliveredKeys.add(preparedTarget.dedupeKey);
      pendingEntries.push(entry);
      params.onDelivered?.({
        plannedTarget,
        preparedTarget,
        request: params.request,
        entry,
      });
    } catch (error) {
      params.onDeliveryError?.({
        error,
        plannedTarget,
        request: params.request,
      });
    }
  }

  return pendingEntries;
}

function defaultResolveApprovalKind(request: ApprovalRequest): ChannelApprovalKind {
  return request.id.startsWith("plugin:") ? "plugin" : "exec";
}

type ChannelNativeApprovalRuntimeAdapter<
  TPendingEntry,
  TPreparedTarget,
  TPendingContent,
  TRequest extends ApprovalRequest = ApprovalRequest,
  TResolved extends ApprovalResolved = ApprovalResolved,
> = Omit<
  ExecApprovalChannelRuntimeAdapter<TPendingEntry, TRequest, TResolved>,
  "deliverRequested"
> & {
  accountId?: string | null;
  nativeAdapter?: ChannelApprovalNativeAdapter | null;
  resolveApprovalKind?: (request: TRequest) => ChannelApprovalKind;
  buildPendingContent: (params: {
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    nowMs: number;
  }) => TPendingContent | Promise<TPendingContent>;
  sendOriginNotice?: (params: {
    originTarget: ChannelApprovalNativeTarget;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
  }) => Promise<void>;
  prepareTarget: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
  }) =>
    | PreparedChannelNativeApprovalTarget<TPreparedTarget>
    | null
    | Promise<PreparedChannelNativeApprovalTarget<TPreparedTarget> | null>;
  deliverTarget: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: TPreparedTarget;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
  }) => TPendingEntry | null | Promise<TPendingEntry | null>;
  onOriginNoticeError?: (params: {
    error: unknown;
    originTarget: ChannelApprovalNativeTarget;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
  }) => void;
  onDeliveryError?: (params: {
    error: unknown;
    plannedTarget: ChannelApprovalNativePlannedTarget;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
  }) => void;
  onDuplicateSkipped?: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
  }) => void;
  onDelivered?: (params: {
    plannedTarget: ChannelApprovalNativePlannedTarget;
    preparedTarget: PreparedChannelNativeApprovalTarget<TPreparedTarget>;
    request: TRequest;
    approvalKind: ChannelApprovalKind;
    pendingContent: TPendingContent;
    entry: TPendingEntry;
  }) => void;
};

export function createChannelNativeApprovalRuntime<
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
  const resolveApprovalKind =
    adapter.resolveApprovalKind ?? ((request: TRequest) => defaultResolveApprovalKind(request));

  return createExecApprovalChannelRuntime<TPendingEntry, TRequest, TResolved>({
    label: adapter.label,
    clientDisplayName: adapter.clientDisplayName,
    cfg: adapter.cfg,
    gatewayUrl: adapter.gatewayUrl,
    eventKinds: adapter.eventKinds,
    isConfigured: adapter.isConfigured,
    shouldHandle: adapter.shouldHandle,
    finalizeResolved: adapter.finalizeResolved,
    finalizeExpired: adapter.finalizeExpired,
    nowMs,
    deliverRequested: async (request) => {
      const approvalKind = resolveApprovalKind(request);
      const pendingContent = await adapter.buildPendingContent({
        request,
        approvalKind,
        nowMs: nowMs(),
      });
      return await deliverApprovalRequestViaChannelNativePlan({
        cfg: adapter.cfg,
        accountId: adapter.accountId,
        approvalKind,
        request,
        adapter: adapter.nativeAdapter,
        sendOriginNotice: adapter.sendOriginNotice
          ? async ({ originTarget, request }) => {
              await adapter.sendOriginNotice?.({
                originTarget,
                request,
                approvalKind,
                pendingContent,
              });
            }
          : undefined,
        prepareTarget: async ({ plannedTarget, request }) =>
          await adapter.prepareTarget({
            plannedTarget,
            request,
            approvalKind,
            pendingContent,
          }),
        deliverTarget: async ({ plannedTarget, preparedTarget, request }) =>
          await adapter.deliverTarget({
            plannedTarget,
            preparedTarget,
            request,
            approvalKind,
            pendingContent,
          }),
        onOriginNoticeError: adapter.onOriginNoticeError
          ? ({ error, originTarget, request }) => {
              adapter.onOriginNoticeError?.({
                error,
                originTarget,
                request,
                approvalKind,
                pendingContent,
              });
            }
          : undefined,
        onDeliveryError: adapter.onDeliveryError
          ? ({ error, plannedTarget, request }) => {
              adapter.onDeliveryError?.({
                error,
                plannedTarget,
                request,
                approvalKind,
                pendingContent,
              });
            }
          : undefined,
        onDuplicateSkipped: adapter.onDuplicateSkipped
          ? ({ plannedTarget, preparedTarget, request }) => {
              adapter.onDuplicateSkipped?.({
                plannedTarget,
                preparedTarget,
                request,
                approvalKind,
                pendingContent,
              });
            }
          : undefined,
        onDelivered: adapter.onDelivered
          ? ({ plannedTarget, preparedTarget, request, entry }) => {
              adapter.onDelivered?.({
                plannedTarget,
                preparedTarget,
                request,
                approvalKind,
                pendingContent,
                entry,
              });
            }
          : undefined,
      });
    },
  });
}
