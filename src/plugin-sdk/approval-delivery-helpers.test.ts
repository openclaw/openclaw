import { describe, expect, it, vi } from "vitest";
import { createApproverRestrictedNativeApprovalAdapter } from "./approval-delivery-helpers.js";

describe("createApproverRestrictedNativeApprovalAdapter", () => {
  it("uses approver-restricted authorization for exec and plugin commands", () => {
    const adapter = createApproverRestrictedNativeApprovalAdapter({
      channel: "discord",
      channelLabel: "Discord",
      listAccountIds: () => ["work"],
      hasApprovers: ({ accountId }) => accountId === "work",
      isExecAuthorizedSender: ({ senderId }) => senderId === "exec-owner",
      isPluginAuthorizedSender: ({ senderId }) => senderId === "plugin-owner",
      isNativeDeliveryEnabled: () => true,
      resolveNativeDeliveryMode: () => "dm",
    });

    expect(
      adapter.authorizeCommand({
        cfg: {} as never,
        accountId: "work",
        senderId: "exec-owner",
        kind: "exec",
      }),
    ).toEqual({ authorized: true });

    expect(
      adapter.authorizeCommand({
        cfg: {} as never,
        accountId: "work",
        senderId: "plugin-owner",
        kind: "plugin",
      }),
    ).toEqual({ authorized: true });

    expect(
      adapter.authorizeCommand({
        cfg: {} as never,
        accountId: "work",
        senderId: "someone-else",
        kind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Discord.",
    });
  });

  it("reports initiating-surface state and DM routing from configured approvers", () => {
    const adapter = createApproverRestrictedNativeApprovalAdapter({
      channel: "telegram",
      channelLabel: "Telegram",
      listAccountIds: () => ["dm-only", "channel-only", "disabled", "no-approvers"],
      hasApprovers: ({ accountId }) => accountId !== "no-approvers",
      isExecAuthorizedSender: () => true,
      isNativeDeliveryEnabled: ({ accountId }) => accountId !== "disabled",
      resolveNativeDeliveryMode: ({ accountId }) =>
        accountId === "channel-only" ? "channel" : "dm",
    });

    expect(adapter.getInitiatingSurfaceState({ cfg: {} as never, accountId: "dm-only" })).toEqual({
      kind: "enabled",
    });
    expect(
      adapter.getInitiatingSurfaceState({ cfg: {} as never, accountId: "no-approvers" }),
    ).toEqual({ kind: "disabled" });
    expect(adapter.hasConfiguredDmRoute({ cfg: {} as never })).toBe(true);
  });

  it("suppresses forwarding fallback only for matching native-delivery surfaces", () => {
    const isNativeDeliveryEnabled = vi.fn(
      ({ accountId }: { accountId?: string | null }) => accountId === "topic-1",
    );
    const adapter = createApproverRestrictedNativeApprovalAdapter({
      channel: "telegram",
      channelLabel: "Telegram",
      listAccountIds: () => [],
      hasApprovers: () => true,
      isExecAuthorizedSender: () => true,
      isNativeDeliveryEnabled,
      resolveNativeDeliveryMode: () => "both",
      requireMatchingTurnSourceChannel: true,
      resolveSuppressionAccountId: ({ request }) =>
        request.request.turnSourceAccountId?.trim() || undefined,
    });

    expect(
      adapter.shouldSuppressForwardingFallback({
        cfg: {} as never,
        target: { channel: "telegram" },
        request: {
          request: { turnSourceChannel: "telegram", turnSourceAccountId: " topic-1 " },
        } as never,
      }),
    ).toBe(true);

    expect(
      adapter.shouldSuppressForwardingFallback({
        cfg: {} as never,
        target: { channel: "telegram" },
        request: {
          request: { turnSourceChannel: "slack", turnSourceAccountId: "topic-1" },
        } as never,
      }),
    ).toBe(false);

    expect(
      adapter.shouldSuppressForwardingFallback({
        cfg: {} as never,
        target: { channel: "slack" },
        request: {
          request: { turnSourceChannel: "telegram", turnSourceAccountId: "topic-1" },
        } as never,
      }),
    ).toBe(false);

    expect(isNativeDeliveryEnabled).toHaveBeenCalledWith({
      cfg: {} as never,
      accountId: "topic-1",
    });
  });
});
