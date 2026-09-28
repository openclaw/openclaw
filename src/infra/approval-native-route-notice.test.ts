// Covers requester notices resolved from native approval delivery reports.
import { expect, it } from "vitest";
import type { ChannelApprovalNativePlannedTarget } from "./approval-native-delivery.js";
import {
  resolveApprovalRouteNotice,
  type ApprovalRouteReport,
  type ApprovalRouteSkipReason,
  type GatewayRequestFn,
} from "./approval-native-route-notice.js";
import type { ApprovalRequestInput, ChannelApprovalKind } from "./approval-types.js";

const requestGateway: GatewayRequestFn = async () => {};
const origin = { turnSourceChannel: "slack", turnSourceTo: "channel:C123" } as const;

function createRequest(kind: ChannelApprovalKind): ApprovalRequestInput {
  const base = { id: "approval-123", createdAtMs: 0, expiresAtMs: 60_000 };
  if (kind === "plugin") {
    return { ...base, request: { ...origin, title: "Run report", description: "Render a diff" } };
  }
  if (kind === "system-agent") {
    return {
      ...base,
      request: {
        ...origin,
        title: "Run report",
        description: "Render a diff",
        command: "echo hi",
        proposalHash: "proposal-123",
        sessionId: "session-123",
        allowedDecisions: ["allow-once", "deny"],
      },
    };
  }
  return { ...base, request: { ...origin, command: "echo hi" } };
}

function createReport(params: {
  request: ApprovalRequestInput;
  channel: string;
  label: string;
  surface?: ChannelApprovalNativePlannedTarget["surface"];
  skipReason?: ApprovalRouteSkipReason;
}): ApprovalRouteReport {
  const target: ChannelApprovalNativePlannedTarget = {
    surface: params.surface ?? "approver-dm",
    target: { to: `user:${params.channel}` },
    reason: "preferred",
  };
  const deliveredTargets = params.skipReason ? [] : [target];
  return {
    runtimeId: params.channel,
    request: params.request,
    channel: params.channel,
    channelLabel: params.label,
    deliveryPlan: {
      targets: deliveredTargets,
      originTarget: target.surface === "origin" ? target.target : null,
      notifyOriginWhenDmOnly: false,
    },
    deliveredTargets,
    requestGateway,
    skipReason: params.skipReason,
  };
}

function resolveNoticeText(
  approvalKind: ChannelApprovalKind,
  request: ApprovalRequestInput,
  reports: ApprovalRouteReport[],
): string | null {
  return (
    resolveApprovalRouteNotice({
      activeRuntimes: new Map(reports.map((report) => [report.runtimeId, { requestGateway }])),
      approvalKind,
      request,
      reports,
      missingSelectedRuntime: false,
    })?.text ?? null
  );
}

it.each([
  ["exec", "Control UI"],
  ["plugin", "Control UI or terminal UI"],
  ["system-agent", "Control UI"],
] as const)("routes ambiguous %s ownership to a capable approval surface", (kind, surface) => {
  const request = createRequest(kind);
  expect(
    resolveNoticeText(kind, request, [
      createReport({ request, channel: "slack", label: "Slack", skipReason: "ambiguous-owner" }),
    ]),
  ).toBe(
    `Approval required, but multiple channel accounts can handle this request. Open the ${surface} to approve it.`,
  );
});

it("labels DM deliveries and reports sorted unique destinations", () => {
  const request = createRequest("exec");
  const matrix = createReport({ request, channel: "matrix", label: "Matrix" });
  const telegram = createReport({ request, channel: "telegram", label: "Telegram" });
  expect(resolveNoticeText("exec", request, [telegram, matrix, telegram])).toBe(
    "Approval required. I sent the approval request to Matrix DMs or Telegram DMs, not this chat.",
  );
});

it("labels a channel delivery without the DM suffix", () => {
  const request = createRequest("exec");
  expect(
    resolveNoticeText("exec", request, [
      createReport({ request, channel: "matrix", label: "Matrix", surface: "origin" }),
    ]),
  ).toBe("Approval required. I sent the approval request to Matrix, not this chat.");
});

it("suppresses a requester notice when no delivery destination exists", () => {
  const request = createRequest("exec");
  expect(resolveNoticeText("exec", request, [])).toBeNull();
});
