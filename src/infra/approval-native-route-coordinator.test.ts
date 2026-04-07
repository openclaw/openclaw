import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearApprovalNativeRouteStateForTest,
  createApprovalNativeRouteReporter,
} from "./approval-native-route-coordinator.js";

afterEach(() => {
  clearApprovalNativeRouteStateForTest();
});

describe("createApprovalNativeRouteReporter", () => {
  it("does not wait on runtimes that start after a request was already observed", async () => {
    const requestGateway = vi.fn(async () => ({ ok: true }));
    const lateRuntimeGateway = vi.fn(async () => ({ ok: true }));
    const request = {
      id: "approval-1",
      request: {
        command: "echo hi",
        turnSourceChannel: "slack",
        turnSourceTo: "channel:C123",
        turnSourceAccountId: "default",
        turnSourceThreadId: "1712345678.123456",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    } as const;

    const reporter = createApprovalNativeRouteReporter({
      handledKinds: new Set(["exec"]),
      channel: "slack",
      channelLabel: "Slack",
      accountId: "default",
      requestGateway,
    });
    reporter.start();
    reporter.observeRequest({
      approvalKind: "exec",
      request,
    });

    const lateReporter = createApprovalNativeRouteReporter({
      handledKinds: new Set(["exec"]),
      channel: "slack",
      channelLabel: "Slack",
      accountId: "default",
      requestGateway: lateRuntimeGateway,
    });
    lateReporter.start();

    await reporter.reportDelivery({
      approvalKind: "exec",
      request,
      deliveryPlan: {
        targets: [],
        originTarget: {
          to: "channel:C123",
          threadId: "1712345678.123456",
        },
        notifyOriginWhenDmOnly: true,
      },
      deliveredTargets: [
        {
          surface: "approver-dm",
          target: {
            to: "user:owner",
          },
          reason: "preferred",
        },
      ],
    });

    expect(requestGateway).toHaveBeenCalledWith("send", {
      channel: "slack",
      to: "channel:C123",
      accountId: "default",
      threadId: "1712345678.123456",
      message: "Approval required. I sent the approval request to Slack DMs, not this chat.",
      idempotencyKey: "approval-route-notice:approval-1",
    });
    expect(lateRuntimeGateway).not.toHaveBeenCalled();
  });
});
