import type {
  ChannelApprovalNativeDeliveryPlan,
  ChannelApprovalNativePlannedTarget,
} from "./approval-native-delivery.js";
import {
  describeExecApprovalDeliveryDestination,
  resolveExecApprovalRoutedElsewhereNoticeText,
} from "./approval-native-route-notice.js";
import { buildChannelApprovalNativeTargetKey } from "./approval-native-target-key.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";

type GatewayRequestFn = <T = unknown>(
  method: string,
  params: Record<string, unknown>,
) => Promise<T>;

type ExecRouteRuntimeRecord = {
  runtimeId: string;
  handlesExec: boolean;
  channel?: string;
  channelLabel?: string;
  accountId?: string | null;
  requestGateway: GatewayRequestFn;
};

type ExecRouteReport = {
  runtimeId: string;
  request: ExecApprovalRequest;
  channel?: string;
  channelLabel?: string;
  accountId?: string | null;
  deliveryPlan: ChannelApprovalNativeDeliveryPlan;
  deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
  requestGateway: GatewayRequestFn;
};

type PendingExecRouteNotice = {
  request: ExecApprovalRequest;
  expectedRuntimeIds: Set<string>;
  reports: Map<string, ExecRouteReport>;
  cleanupTimeout: NodeJS.Timeout | null;
  finalized: boolean;
};

type RouteNoticeTarget = {
  channel: string;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

const activeExecRouteRuntimes = new Map<string, ExecRouteRuntimeRecord>();
const pendingExecRouteNotices = new Map<string, PendingExecRouteNotice>();
let execRouteRuntimeSeq = 0;

function normalizeChannel(value?: string | null): string {
  return value?.trim().toLowerCase() || "";
}

function clearPendingExecRouteNotice(approvalId: string): void {
  const entry = pendingExecRouteNotices.get(approvalId);
  if (!entry) {
    return;
  }
  pendingExecRouteNotices.delete(approvalId);
  if (entry.cleanupTimeout) {
    clearTimeout(entry.cleanupTimeout);
  }
}

function createPendingExecRouteNotice(request: ExecApprovalRequest): PendingExecRouteNotice {
  const timeoutMs = Math.max(0, request.expiresAtMs - Date.now());
  const cleanupTimeout = setTimeout(() => {
    clearPendingExecRouteNotice(request.id);
  }, timeoutMs);
  cleanupTimeout.unref?.();
  return {
    request,
    // Snapshot the active exec runtimes so we emit one notice only after every
    // sibling runtime has reported its actual delivery outcome for this approval.
    expectedRuntimeIds: new Set(
      Array.from(activeExecRouteRuntimes.values())
        .filter((runtime) => runtime.handlesExec)
        .map((runtime) => runtime.runtimeId),
    ),
    reports: new Map(),
    cleanupTimeout,
    finalized: false,
  };
}

function resolveRouteNoticeTargetFromRequest(
  request: ExecApprovalRequest,
): RouteNoticeTarget | null {
  const channel = request.request.turnSourceChannel?.trim();
  const to = request.request.turnSourceTo?.trim();
  if (!channel || !to) {
    return null;
  }
  return {
    channel,
    to,
    accountId: request.request.turnSourceAccountId ?? undefined,
    threadId: request.request.turnSourceThreadId ?? undefined,
  };
}

function resolveFallbackRouteNoticeTarget(report: ExecRouteReport): RouteNoticeTarget | null {
  const channel = report.channel?.trim();
  const to = report.deliveryPlan.originTarget?.to?.trim();
  if (!channel || !to) {
    return null;
  }
  return {
    channel,
    to,
    accountId: report.accountId ?? undefined,
    threadId: report.deliveryPlan.originTarget?.threadId ?? undefined,
  };
}

function didReportDeliverToOrigin(report: ExecRouteReport): boolean {
  const originTarget = report.deliveryPlan.originTarget;
  if (!originTarget) {
    return false;
  }
  const originKey = buildChannelApprovalNativeTargetKey(originTarget);
  return report.deliveredTargets.some(
    (plannedTarget) => buildChannelApprovalNativeTargetKey(plannedTarget.target) === originKey,
  );
}

function resolveExecRouteNotice(params: {
  request: ExecApprovalRequest;
  reports: readonly ExecRouteReport[];
}): { requestGateway: GatewayRequestFn; target: RouteNoticeTarget; text: string } | null {
  const explicitTarget = resolveRouteNoticeTargetFromRequest(params.request);
  const originChannel = normalizeChannel(
    explicitTarget?.channel ?? params.request.request.turnSourceChannel,
  );
  const fallbackTarget =
    params.reports
      .filter((report) => normalizeChannel(report.channel) === originChannel || !originChannel)
      .map(resolveFallbackRouteNoticeTarget)
      .find((target) => target !== null) ?? null;
  const target = explicitTarget ?? fallbackTarget;
  if (!target) {
    return null;
  }

  // If any same-channel runtime already delivered into the origin chat, every
  // other fallback delivery becomes supplemental and should not trigger a notice.
  const originDelivered = params.reports.some((report) => {
    if (originChannel && normalizeChannel(report.channel) !== originChannel) {
      return false;
    }
    return didReportDeliverToOrigin(report);
  });
  if (originDelivered) {
    return null;
  }

  const destinations = params.reports.flatMap((report) => {
    if (!report.channelLabel || report.deliveredTargets.length === 0) {
      return [];
    }
    const reportChannel = normalizeChannel(report.channel);
    if (
      originChannel &&
      reportChannel === originChannel &&
      !report.deliveryPlan.notifyOriginWhenDmOnly
    ) {
      return [];
    }
    return [
      describeExecApprovalDeliveryDestination({
        channelLabel: report.channelLabel,
        deliveredTargets: report.deliveredTargets,
      }),
    ];
  });
  const text = resolveExecApprovalRoutedElsewhereNoticeText(destinations);
  if (!text) {
    return null;
  }

  const requestGateway =
    params.reports.find((report) => activeExecRouteRuntimes.has(report.runtimeId))
      ?.requestGateway ?? params.reports[0]?.requestGateway;
  if (!requestGateway) {
    return null;
  }

  return {
    requestGateway,
    target,
    text,
  };
}

async function maybeFinalizeExecRouteNotice(approvalId: string): Promise<void> {
  const entry = pendingExecRouteNotices.get(approvalId);
  if (!entry || entry.finalized) {
    return;
  }
  for (const runtimeId of entry.expectedRuntimeIds) {
    if (!entry.reports.has(runtimeId)) {
      return;
    }
  }

  entry.finalized = true;
  const reports = Array.from(entry.reports.values());
  const notice = resolveExecRouteNotice({
    request: entry.request,
    reports,
  });
  clearPendingExecRouteNotice(approvalId);
  if (!notice) {
    return;
  }

  try {
    await notice.requestGateway("send", {
      channel: notice.target.channel,
      to: notice.target.to,
      accountId: notice.target.accountId ?? undefined,
      threadId: notice.target.threadId ?? undefined,
      message: notice.text,
      idempotencyKey: `approval-route-notice:${approvalId}`,
    });
  } catch {
    // The approval delivery already succeeded; the follow-up notice is best-effort.
  }
}

export function createExecApprovalNativeRouteReporter(params: {
  handlesExec: boolean;
  channel?: string;
  channelLabel?: string;
  accountId?: string | null;
  requestGateway: GatewayRequestFn;
}) {
  const runtimeId = `native-approval-route:${++execRouteRuntimeSeq}`;
  let registered = false;

  const report = async (payload: {
    request: ExecApprovalRequest;
    deliveryPlan: ChannelApprovalNativeDeliveryPlan;
    deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
  }): Promise<void> => {
    if (!registered || !params.handlesExec) {
      return;
    }
    const entry =
      pendingExecRouteNotices.get(payload.request.id) ??
      createPendingExecRouteNotice(payload.request);
    entry.expectedRuntimeIds.add(runtimeId);
    entry.reports.set(runtimeId, {
      runtimeId,
      request: payload.request,
      channel: params.channel,
      channelLabel: params.channelLabel,
      accountId: params.accountId,
      deliveryPlan: payload.deliveryPlan,
      deliveredTargets: payload.deliveredTargets,
      requestGateway: params.requestGateway,
    });
    pendingExecRouteNotices.set(payload.request.id, entry);
    await maybeFinalizeExecRouteNotice(payload.request.id);
  };

  return {
    start(): void {
      if (registered) {
        return;
      }
      activeExecRouteRuntimes.set(runtimeId, {
        runtimeId,
        handlesExec: params.handlesExec,
        channel: params.channel,
        channelLabel: params.channelLabel,
        accountId: params.accountId,
        requestGateway: params.requestGateway,
      });
      registered = true;
    },
    async reportSkipped(request: ExecApprovalRequest): Promise<void> {
      await report({
        request,
        deliveryPlan: {
          targets: [],
          originTarget: null,
          notifyOriginWhenDmOnly: false,
        },
        deliveredTargets: [],
      });
    },
    async reportDelivery(params: {
      request: ExecApprovalRequest;
      deliveryPlan: ChannelApprovalNativeDeliveryPlan;
      deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
    }): Promise<void> {
      await report(params);
    },
    async stop(): Promise<void> {
      if (!registered) {
        return;
      }
      registered = false;
      activeExecRouteRuntimes.delete(runtimeId);
      for (const entry of pendingExecRouteNotices.values()) {
        entry.expectedRuntimeIds.delete(runtimeId);
        if (entry.expectedRuntimeIds.size === 0) {
          clearPendingExecRouteNotice(entry.request.id);
          continue;
        }
        await maybeFinalizeExecRouteNotice(entry.request.id);
      }
    },
  };
}

export function clearExecApprovalNativeRouteStateForTest(): void {
  for (const approvalId of Array.from(pendingExecRouteNotices.keys())) {
    clearPendingExecRouteNotice(approvalId);
  }
  activeExecRouteRuntimes.clear();
  execRouteRuntimeSeq = 0;
}
