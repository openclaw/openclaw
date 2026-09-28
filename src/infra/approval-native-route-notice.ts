import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
// Resolves native-route approval notices and formats their visible text.
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatHumanList } from "../shared/human-list.js";
import type {
  ChannelApprovalNativeDeliveryPlan,
  ChannelApprovalNativePlannedTarget,
} from "./approval-native-delivery.js";
import { buildChannelApprovalNativeTargetKey } from "./approval-native-target-key.js";
import type {
  ApprovalRequestInput as ApprovalRequest,
  ChannelApprovalKind,
} from "./approval-types.js";

export type ApprovalRouteSendParams = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
  message: string;
  idempotencyKey: string;
};

export type GatewayRequestFn = (
  method: "send",
  params: ApprovalRouteSendParams,
  options?: {
    liveOnlyWhenCurrent: (cfg?: OpenClawConfig) => boolean;
    approvalRequest?: ApprovalRequest;
  },
) => Promise<void>;

export type ApprovalRouteSkipReason = "ambiguous-owner" | "ineligible" | "owner-unavailable";

export type ApprovalRouteReport = {
  runtimeId: string;
  request: ApprovalRequest;
  channel?: string;
  channelLabel?: string;
  accountId?: string | null;
  deliveryPlan: ChannelApprovalNativeDeliveryPlan;
  deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
  requestGateway: GatewayRequestFn;
  skipReason?: ApprovalRouteSkipReason;
};

export type RouteNoticeTarget = {
  channel: string;
  to: string;
  accountId?: string | null;
  threadId?: string | number | null;
};

/** Formats the human destination label for where native approval prompts were delivered. */
function describeApprovalDeliveryDestination(params: {
  channelLabel: string;
  deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
}): string {
  const surfaces = new Set(params.deliveredTargets.map((target) => target.surface));
  return surfaces.size === 1 && surfaces.has("approver-dm")
    ? `${params.channelLabel} DMs`
    : params.channelLabel;
}

/** Builds the notice shown in the current chat when approval was routed elsewhere. */
function resolveApprovalRoutedElsewhereNoticeText(
  destinations: readonly string[],
  approvalId?: string,
): string | null {
  const uniqueDestinations = sortUniqueStrings(destinations.map((value) => value.trim())).filter(
    Boolean,
  );
  if (uniqueDestinations.length === 0) {
    return null;
  }
  return `Approval${approvalId ? ` ${approvalId}` : ""} required. I sent the approval request to ${formatHumanList(
    uniqueDestinations,
  )}, not this chat.`;
}

/** Builds the recovery notice when no channel account uniquely owns the approval. */
function resolveAmbiguousApprovalRouteNoticeText(approvalKind: ChannelApprovalKind): string {
  const surface = approvalKind === "plugin" ? "Control UI or terminal UI" : "Control UI";
  return `Approval required, but multiple channel accounts can handle this request. Open the ${surface} to approve it.`;
}

/** Builds the fallback slash-command notice when native approval delivery fails. */
function resolveApprovalDeliveryFailedNoticeText(params: {
  approvalId: string;
  approvalKind: ChannelApprovalKind;
  allowedDecisions?: readonly string[];
}): string {
  const commandId =
    params.approvalKind === "exec" && params.approvalId.length > 8
      ? params.approvalId.slice(0, 8)
      : params.approvalId;
  // Exec approval ids are long command ids in chat UX; plugin ids can be short
  // semantic ids, so only shorten exec ids and keep the full-id fallback visible.
  const decisions = (
    params.allowedDecisions?.length
      ? params.allowedDecisions
      : ["allow-once", "allow-always", "deny"]
  ).join("|");
  return [
    params.approvalKind === "plugin"
      ? "Approval required. A native approval delivery attempt failed."
      : "Approval required. I could not deliver the native approval request.",
    `Reply with: /approve ${commandId} ${decisions}`,
    "If the short code is ambiguous, use the full id in /approve.",
  ].join("\n");
}

export function normalizeApprovalRouteChannel(value?: string | null): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function resolveRouteNoticeTargetFromRequest(request: ApprovalRequest): RouteNoticeTarget | null {
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

function resolveFallbackRouteNoticeTarget(report: ApprovalRouteReport): RouteNoticeTarget | null {
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

function didReportDeliverToOrigin(report: ApprovalRouteReport, originAccountId?: string): boolean {
  const originTarget = report.deliveryPlan.originTarget;
  if (!originTarget) {
    return false;
  }
  const reportAccountId = normalizeOptionalString(report.accountId);
  if (
    originAccountId !== undefined &&
    reportAccountId !== undefined &&
    reportAccountId !== originAccountId
  ) {
    return false;
  }
  const originKey = buildChannelApprovalNativeTargetKey(originTarget);
  return report.deliveredTargets.some(
    (plannedTarget) => buildChannelApprovalNativeTargetKey(plannedTarget.target) === originKey,
  );
}

function hasPlannedNativeTargets(report: ApprovalRouteReport): boolean {
  return report.deliveryPlan.targets.length > 0;
}

function readAllowedDecisionStrings(request: ApprovalRequest): string[] | undefined {
  const allowedDecisions =
    "allowedDecisions" in request.request ? request.request.allowedDecisions : undefined;
  if (!Array.isArray(allowedDecisions)) {
    return undefined;
  }
  return allowedDecisions.filter((value): value is string => typeof value === "string");
}

export function resolveApprovalRouteNotice(params: {
  activeRuntimes: ReadonlyMap<string, { requestGateway: GatewayRequestFn }>;
  approvalKind: ChannelApprovalKind;
  request: ApprovalRequest;
  reports: readonly ApprovalRouteReport[];
  missingSelectedRuntime: boolean;
}): { requestGateway: GatewayRequestFn; target: RouteNoticeTarget; text: string } | null {
  const explicitTarget = resolveRouteNoticeTargetFromRequest(params.request);
  const originChannel = normalizeApprovalRouteChannel(
    explicitTarget?.channel ?? params.request.request.turnSourceChannel,
  );
  const fallbackTarget =
    params.reports
      .filter(
        (report) =>
          normalizeApprovalRouteChannel(report.channel) === originChannel || !originChannel,
      )
      .map(resolveFallbackRouteNoticeTarget)
      .find((target) => target !== null) ?? null;
  const target = explicitTarget
    ? {
        ...fallbackTarget,
        ...explicitTarget,
        accountId: explicitTarget.accountId ?? fallbackTarget?.accountId,
        threadId: explicitTarget.threadId ?? fallbackTarget?.threadId,
      }
    : fallbackTarget;
  if (!target) {
    return null;
  }
  const originAccountId = normalizeOptionalString(target.accountId);
  const deliveredAnyTarget = params.reports.some((report) => report.deliveredTargets.length > 0);
  const ambiguousOwner = params.reports.some((report) => report.skipReason === "ambiguous-owner");
  const requiresManualFallback =
    ambiguousOwner || params.reports.some((report) => report.skipReason === "owner-unavailable");
  if (
    !deliveredAnyTarget &&
    (params.reports.some(hasPlannedNativeTargets) ||
      requiresManualFallback ||
      params.missingSelectedRuntime)
  ) {
    const requestGateway =
      params.reports.find((report) => params.activeRuntimes.has(report.runtimeId))
        ?.requestGateway ??
      params.reports[0]?.requestGateway ??
      Array.from(params.activeRuntimes.values())[0]?.requestGateway;
    if (!requestGateway) {
      return null;
    }
    return {
      requestGateway,
      target,
      text: ambiguousOwner
        ? resolveAmbiguousApprovalRouteNoticeText(params.approvalKind)
        : resolveApprovalDeliveryFailedNoticeText({
            approvalId: params.request.id,
            approvalKind: params.approvalKind,
            allowedDecisions: readAllowedDecisionStrings(params.request),
          }),
    };
  }

  // If any same-channel runtime already delivered into the origin chat, every
  // other fallback delivery becomes supplemental and should not trigger a notice.
  const originDelivered = params.reports.some((report) => {
    if (originChannel && normalizeApprovalRouteChannel(report.channel) !== originChannel) {
      return false;
    }
    return didReportDeliverToOrigin(report, originAccountId);
  });
  if (originDelivered) {
    return null;
  }

  const destinations = params.reports.flatMap((report) => {
    if (!report.channelLabel || report.deliveredTargets.length === 0) {
      return [];
    }
    const reportChannel = normalizeApprovalRouteChannel(report.channel);
    if (
      originChannel &&
      reportChannel === originChannel &&
      !report.deliveryPlan.notifyOriginWhenDmOnly
    ) {
      return [];
    }
    const reportAccountId = normalizeOptionalString(report.accountId);
    if (
      originChannel &&
      reportChannel === originChannel &&
      originAccountId !== undefined &&
      reportAccountId !== undefined &&
      reportAccountId !== originAccountId
    ) {
      return [];
    }
    return [
      describeApprovalDeliveryDestination({
        channelLabel: report.channelLabel,
        deliveredTargets: report.deliveredTargets,
      }),
    ];
  });
  const text = resolveApprovalRoutedElsewhereNoticeText(
    destinations,
    params.approvalKind === "plugin" ? params.request.id : undefined,
  );
  if (!text) {
    return null;
  }

  const requestGateway =
    params.reports.find((report) => params.activeRuntimes.has(report.runtimeId))?.requestGateway ??
    params.reports[0]?.requestGateway;
  if (!requestGateway) {
    return null;
  }

  return {
    requestGateway,
    target,
    text,
  };
}
