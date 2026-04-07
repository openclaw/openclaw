import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelApprovalNativeAdapter } from "../channels/plugins/types.adapters.js";
import { clearApprovalNativeRouteStateForTest } from "./approval-native-route-coordinator.js";
import {
  createChannelNativeApprovalRuntime,
  deliverApprovalRequestViaChannelNativePlan,
} from "./approval-native-runtime.js";

const mockGatewayClientStarts = vi.hoisted(() => vi.fn());
const mockGatewayClientStops = vi.hoisted(() => vi.fn());
const mockGatewayClientRequests = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const mockCreateOperatorApprovalsGatewayClient = vi.hoisted(() => vi.fn());

vi.mock("../gateway/operator-approvals-client.js", () => ({
  createOperatorApprovalsGatewayClient: mockCreateOperatorApprovalsGatewayClient,
}));

const execRequest = {
  id: "approval-1",
  request: {
    command: "uname -a",
  },
  createdAtMs: 0,
  expiresAtMs: 120_000,
};

afterEach(() => {
  clearApprovalNativeRouteStateForTest();
  vi.useRealTimers();
});

describe("deliverApprovalRequestViaChannelNativePlan", () => {
  it("dedupes converged prepared targets", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "approver-dm",
        supportsOriginSurface: true,
        supportsApproverDmSurface: true,
        notifyOriginWhenDmOnly: true,
      }),
      resolveOriginTarget: async () => ({ to: "origin-room" }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }, { to: "approver-2" }],
    };
    const prepareTarget = vi
      .fn()
      .mockImplementation(
        async ({ plannedTarget }: { plannedTarget: { target: { to: string } } }) =>
          plannedTarget.target.to === "approver-1"
            ? {
                dedupeKey: "shared-dm",
                target: { channelId: "shared-dm", recipientId: "approver-1" },
              }
            : {
                dedupeKey: "shared-dm",
                target: { channelId: "shared-dm", recipientId: "approver-2" },
              },
      );
    const deliverTarget = vi
      .fn()
      .mockImplementation(
        async ({ preparedTarget }: { preparedTarget: { channelId: string } }) => ({
          channelId: preparedTarget.channelId,
        }),
      );
    const onDuplicateSkipped = vi.fn();

    const result = await deliverApprovalRequestViaChannelNativePlan({
      cfg: {} as never,
      approvalKind: "exec",
      request: execRequest,
      adapter,
      prepareTarget,
      deliverTarget,
      onDuplicateSkipped,
    });

    expect(prepareTarget).toHaveBeenCalledTimes(2);
    expect(deliverTarget).toHaveBeenCalledTimes(1);
    expect(onDuplicateSkipped).toHaveBeenCalledTimes(1);
    expect(result.entries).toEqual([{ channelId: "shared-dm" }]);
    expect(result.deliveryPlan.notifyOriginWhenDmOnly).toBe(true);
  });

  it("continues after per-target delivery failures", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "approver-dm",
        supportsOriginSurface: false,
        supportsApproverDmSurface: true,
      }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }, { to: "approver-2" }],
    };
    const onDeliveryError = vi.fn();

    const result = await deliverApprovalRequestViaChannelNativePlan({
      cfg: {} as never,
      approvalKind: "exec",
      request: execRequest,
      adapter,
      prepareTarget: ({ plannedTarget }) => ({
        dedupeKey: plannedTarget.target.to,
        target: { channelId: plannedTarget.target.to },
      }),
      deliverTarget: async ({ preparedTarget }) => {
        if (preparedTarget.channelId === "approver-1") {
          throw new Error("boom");
        }
        return { channelId: preparedTarget.channelId };
      },
      onDeliveryError,
    });

    expect(onDeliveryError).toHaveBeenCalledTimes(1);
    expect(result.entries).toEqual([{ channelId: "approver-2" }]);
  });
});

describe("createChannelNativeApprovalRuntime", () => {
  it("posts a same-channel DM redirect notice through the gateway after actual delivery", async () => {
    mockGatewayClientStarts.mockReset();
    mockGatewayClientStops.mockReset();
    mockGatewayClientRequests.mockReset();
    mockCreateOperatorApprovalsGatewayClient.mockReset().mockResolvedValue({
      start: mockGatewayClientStarts,
      stop: mockGatewayClientStops,
      request: mockGatewayClientRequests,
    });
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-same-channel-route-notice",
      clientDisplayName: "Test",
      channel: "slack",
      channelLabel: "Slack",
      cfg: {} as never,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: true,
          supportsApproverDmSurface: true,
          notifyOriginWhenDmOnly: true,
        }),
        resolveOriginTarget: async () => ({ to: "channel:C123", threadId: "1712345678.123456" }),
        resolveApproverDmTargets: async () => [{ to: "owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "dm:owner",
        target: { chatId: "owner" },
      }),
      deliverTarget: async () => ({ chatId: "owner", messageId: "m1" }),
      finalizeResolved: async () => {},
    });

    await runtime.start();
    await runtime.handleRequested({
      id: "req-1",
      request: {
        command: "echo hi",
        turnSourceChannel: "slack",
        turnSourceTo: "channel:C123",
        turnSourceAccountId: "default",
        turnSourceThreadId: "1712345678.123456",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    });

    expect(mockGatewayClientRequests).toHaveBeenCalledWith("send", {
      channel: "slack",
      to: "channel:C123",
      accountId: "default",
      threadId: "1712345678.123456",
      message: "Approval required. I sent the approval request to Slack DMs, not this chat.",
      idempotencyKey: "approval-route-notice:req-1",
    });
    await runtime.stop();
  });

  it("posts the same redirect notice for plugin approvals", async () => {
    mockGatewayClientStarts.mockReset();
    mockGatewayClientStops.mockReset();
    mockGatewayClientRequests.mockReset();
    mockCreateOperatorApprovalsGatewayClient.mockReset().mockResolvedValue({
      start: mockGatewayClientStarts,
      stop: mockGatewayClientStops,
      request: mockGatewayClientRequests,
    });
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-plugin-route-notice",
      clientDisplayName: "Discord",
      channel: "discord",
      channelLabel: "Discord",
      cfg: {} as never,
      eventKinds: ["exec", "plugin"],
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: true,
          supportsApproverDmSurface: true,
          notifyOriginWhenDmOnly: true,
        }),
        resolveOriginTarget: async () => ({ to: "channel:C123", threadId: "1712345678.123456" }),
        resolveApproverDmTargets: async () => [{ to: "user:owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      resolveApprovalKind: (request) => (request.id.startsWith("plugin:") ? "plugin" : "exec"),
      buildPendingContent: async () => "pending plugin",
      prepareTarget: async () => ({
        dedupeKey: "discord-dm:owner",
        target: { chatId: "owner" },
      }),
      deliverTarget: async () => ({ chatId: "owner", messageId: "m1" }),
      finalizeResolved: async () => {},
    });

    await runtime.start();
    await runtime.handleRequested({
      id: "plugin:req-1",
      request: {
        title: "Plugin Approval Required",
        description: "Allow plugin action",
        pluginId: "git-tools",
        turnSourceChannel: "discord",
        turnSourceTo: "channel:C123",
        turnSourceAccountId: "default",
        turnSourceThreadId: "1712345678.123456",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    });

    expect(mockGatewayClientRequests).toHaveBeenCalledWith("send", {
      channel: "discord",
      to: "channel:C123",
      accountId: "default",
      threadId: "1712345678.123456",
      message: "Approval required. I sent the approval request to Discord DMs, not this chat.",
      idempotencyKey: "approval-route-notice:plugin:req-1",
    });
    await runtime.stop();
  });

  it("does not block routed-elsewhere notices when another runtime throws in shouldHandle", async () => {
    mockGatewayClientStarts.mockReset();
    mockGatewayClientStops.mockReset();
    mockGatewayClientRequests.mockReset();
    mockCreateOperatorApprovalsGatewayClient.mockReset().mockResolvedValue({
      start: mockGatewayClientStarts,
      stop: mockGatewayClientStops,
      request: mockGatewayClientRequests,
    });
    const failingRuntime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-throwing-should-handle",
      clientDisplayName: "Slack",
      channel: "slack",
      channelLabel: "Slack",
      cfg: {} as never,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: true,
          supportsApproverDmSurface: true,
          notifyOriginWhenDmOnly: true,
        }),
        resolveOriginTarget: async () => ({ to: "channel:C123", threadId: "1712345678.123456" }),
        resolveApproverDmTargets: async () => [{ to: "user:owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => {
        throw new Error("boom");
      },
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "slack-dm:owner",
        target: { chatId: "owner" },
      }),
      deliverTarget: async () => ({ chatId: "owner", messageId: "m1" }),
      finalizeResolved: async () => {},
    });
    const deliveringRuntime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-delivering",
      clientDisplayName: "Slack",
      channel: "slack",
      channelLabel: "Slack",
      cfg: {} as never,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: true,
          supportsApproverDmSurface: true,
          notifyOriginWhenDmOnly: true,
        }),
        resolveOriginTarget: async () => ({ to: "channel:C123", threadId: "1712345678.123456" }),
        resolveApproverDmTargets: async () => [{ to: "user:owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "slack-dm:owner",
        target: { chatId: "owner" },
      }),
      deliverTarget: async () => ({ chatId: "owner", messageId: "m1" }),
      finalizeResolved: async () => {},
    });

    await failingRuntime.start();
    await deliveringRuntime.start();

    await expect(
      failingRuntime.handleRequested({
        id: "req-throwing-should-handle",
        request: {
          command: "echo hi",
          turnSourceChannel: "slack",
          turnSourceTo: "channel:C123",
          turnSourceAccountId: "default",
          turnSourceThreadId: "1712345678.123456",
        },
        createdAtMs: 0,
        expiresAtMs: Date.now() + 60_000,
      }),
    ).rejects.toThrow("boom");

    await deliveringRuntime.handleRequested({
      id: "req-throwing-should-handle",
      request: {
        command: "echo hi",
        turnSourceChannel: "slack",
        turnSourceTo: "channel:C123",
        turnSourceAccountId: "default",
        turnSourceThreadId: "1712345678.123456",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    });

    expect(mockGatewayClientRequests).toHaveBeenCalledWith("send", {
      channel: "slack",
      to: "channel:C123",
      accountId: "default",
      threadId: "1712345678.123456",
      message: "Approval required. I sent the approval request to Slack DMs, not this chat.",
      idempotencyKey: "approval-route-notice:req-throwing-should-handle",
    });

    await failingRuntime.stop();
    await deliveringRuntime.stop();
  });

  it("captures approvals emitted during gateway startup before the first onEvent turn", async () => {
    mockGatewayClientStarts.mockReset();
    mockGatewayClientStops.mockReset();
    mockGatewayClientRequests.mockReset();
    mockCreateOperatorApprovalsGatewayClient.mockReset().mockImplementation(async (params) => ({
      start: () => {
        params.onEvent({
          event: "exec.approval.requested",
          payload: {
            id: "req-startup-race",
            request: {
              command: "echo hi",
              turnSourceChannel: "slack",
              turnSourceTo: "channel:C123",
              turnSourceAccountId: "default",
              turnSourceThreadId: "1712345678.123456",
            },
            createdAtMs: 0,
            expiresAtMs: Date.now() + 60_000,
          },
        });
      },
      stop: mockGatewayClientStops,
      request: mockGatewayClientRequests,
    }));
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-startup-race",
      clientDisplayName: "Slack",
      channel: "slack",
      channelLabel: "Slack",
      cfg: {} as never,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: true,
          supportsApproverDmSurface: true,
          notifyOriginWhenDmOnly: true,
        }),
        resolveOriginTarget: async () => ({ to: "channel:C123", threadId: "1712345678.123456" }),
        resolveApproverDmTargets: async () => [{ to: "user:owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "slack-dm:owner",
        target: { chatId: "owner" },
      }),
      deliverTarget: async () => ({ chatId: "owner", messageId: "m1" }),
      finalizeResolved: async () => {},
    });

    await runtime.start();
    await vi.waitFor(() => {
      expect(mockGatewayClientRequests).toHaveBeenCalledWith("send", {
        channel: "slack",
        to: "channel:C123",
        accountId: "default",
        threadId: "1712345678.123456",
        message: "Approval required. I sent the approval request to Slack DMs, not this chat.",
        idempotencyKey: "approval-route-notice:req-startup-race",
      });
    });
    await runtime.stop();
  });

  it("inherits fallback account and thread when the request omits them", async () => {
    mockGatewayClientStarts.mockReset();
    mockGatewayClientStops.mockReset();
    mockGatewayClientRequests.mockReset();
    mockCreateOperatorApprovalsGatewayClient.mockReset().mockResolvedValue({
      start: mockGatewayClientStarts,
      stop: mockGatewayClientStops,
      request: mockGatewayClientRequests,
    });
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-route-notice-fallback-account",
      clientDisplayName: "Matrix",
      channel: "matrix",
      channelLabel: "Matrix",
      accountId: "alerts",
      cfg: {} as never,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: true,
          supportsApproverDmSurface: true,
          notifyOriginWhenDmOnly: true,
        }),
        resolveOriginTarget: async () => ({ to: "room:!ops:example.org", threadId: "$thread-1" }),
        resolveApproverDmTargets: async () => [{ to: "user:@owner:example.org" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "matrix-dm:owner",
        target: { chatId: "matrix-dm:owner" },
      }),
      deliverTarget: async () => ({ chatId: "matrix-dm:owner", messageId: "m1" }),
      finalizeResolved: async () => {},
    });

    await runtime.start();
    await runtime.handleRequested({
      id: "req-fallback-account",
      request: {
        command: "echo hi",
        turnSourceChannel: "matrix",
        turnSourceTo: "room:!ops:example.org",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    });

    expect(mockGatewayClientRequests).toHaveBeenCalledWith("send", {
      channel: "matrix",
      to: "room:!ops:example.org",
      accountId: "alerts",
      threadId: "$thread-1",
      message: "Approval required. I sent the approval request to Matrix DMs, not this chat.",
      idempotencyKey: "approval-route-notice:req-fallback-account",
    });
    await runtime.stop();
  });

  it("aggregates same-channel and cross-channel fallback destinations into one notice", async () => {
    mockGatewayClientStarts.mockReset();
    mockGatewayClientStops.mockReset();
    mockGatewayClientRequests.mockReset();
    mockCreateOperatorApprovalsGatewayClient.mockReset().mockResolvedValue({
      start: mockGatewayClientStarts,
      stop: mockGatewayClientStops,
      request: mockGatewayClientRequests,
    });
    const matrixRuntime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-matrix-route-notice",
      clientDisplayName: "Matrix",
      channel: "matrix",
      channelLabel: "Matrix",
      cfg: {} as never,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: true,
          supportsApproverDmSurface: true,
          notifyOriginWhenDmOnly: true,
        }),
        resolveOriginTarget: async () => ({ to: "room:!ops:example.org" }),
        resolveApproverDmTargets: async () => [{ to: "user:@owner:example.org" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "matrix-dm:owner",
        target: { chatId: "matrix-dm:owner" },
      }),
      deliverTarget: async () => ({ chatId: "matrix-dm:owner", messageId: "m1" }),
      finalizeResolved: async () => {},
    });
    const telegramRuntime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-telegram-route-notice",
      clientDisplayName: "Telegram",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {} as never,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: false,
          supportsApproverDmSurface: true,
        }),
        resolveApproverDmTargets: async () => [{ to: "owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "telegram-dm:owner",
        target: { chatId: "telegram-dm:owner" },
      }),
      deliverTarget: async () => ({ chatId: "telegram-dm:owner", messageId: "m2" }),
      finalizeResolved: async () => {},
    });

    await matrixRuntime.start();
    await telegramRuntime.start();
    const request = {
      id: "req-2",
      request: {
        command: "echo hi",
        turnSourceChannel: "matrix",
        turnSourceTo: "room:!ops:example.org",
        turnSourceAccountId: "default",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    };

    await telegramRuntime.handleRequested(request);
    await matrixRuntime.handleRequested(request);

    expect(mockGatewayClientRequests).toHaveBeenCalledWith("send", {
      channel: "matrix",
      to: "room:!ops:example.org",
      accountId: "default",
      threadId: undefined,
      message:
        "Approval required. I sent the approval request to Matrix DMs or Telegram DMs, not this chat.",
      idempotencyKey: "approval-route-notice:req-2",
    });
    await matrixRuntime.stop();
    await telegramRuntime.stop();
  });

  it("suppresses the aggregated notice when another runtime already delivered to the origin chat", async () => {
    mockGatewayClientStarts.mockReset();
    mockGatewayClientStops.mockReset();
    mockGatewayClientRequests.mockReset();
    mockCreateOperatorApprovalsGatewayClient.mockReset().mockResolvedValue({
      start: mockGatewayClientStarts,
      stop: mockGatewayClientStops,
      request: mockGatewayClientRequests,
    });
    const matrixRuntime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-matrix-origin-delivered",
      clientDisplayName: "Matrix",
      channel: "matrix",
      channelLabel: "Matrix",
      cfg: {} as never,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "origin",
          supportsOriginSurface: true,
          supportsApproverDmSurface: false,
        }),
        resolveOriginTarget: async () => ({ to: "room:!ops:example.org" }),
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async ({ plannedTarget }) => ({
        dedupeKey: plannedTarget.target.to,
        target: { chatId: plannedTarget.target.to },
      }),
      deliverTarget: async ({ preparedTarget }) => ({
        chatId: preparedTarget.chatId,
        messageId: "matrix-origin",
      }),
      finalizeResolved: async () => {},
    });
    const telegramRuntime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-telegram-elsewhere",
      clientDisplayName: "Telegram",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {} as never,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: false,
          supportsApproverDmSurface: true,
        }),
        resolveApproverDmTargets: async () => [{ to: "owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "telegram-dm:owner",
        target: { chatId: "telegram-dm:owner" },
      }),
      deliverTarget: async () => ({ chatId: "telegram-dm:owner", messageId: "m2" }),
      finalizeResolved: async () => {},
    });

    await matrixRuntime.start();
    await telegramRuntime.start();
    const request = {
      id: "req-3",
      request: {
        command: "echo hi",
        turnSourceChannel: "matrix",
        turnSourceTo: "room:!ops:example.org",
        turnSourceAccountId: "default",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    };

    await telegramRuntime.handleRequested(request);
    await matrixRuntime.handleRequested(request);

    expect(mockGatewayClientRequests).not.toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        idempotencyKey: "approval-route-notice:req-3",
      }),
    );
    await matrixRuntime.stop();
    await telegramRuntime.stop();
  });

  it("respects channels that opt out of same-channel DM redirect notices", async () => {
    mockGatewayClientStarts.mockReset();
    mockGatewayClientStops.mockReset();
    mockGatewayClientRequests.mockReset();
    mockCreateOperatorApprovalsGatewayClient.mockReset().mockResolvedValue({
      start: mockGatewayClientStarts,
      stop: mockGatewayClientStops,
      request: mockGatewayClientRequests,
    });
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-matrix-no-origin-notice",
      clientDisplayName: "Matrix",
      channel: "matrix",
      channelLabel: "Matrix",
      cfg: {} as never,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: true,
          supportsApproverDmSurface: true,
          notifyOriginWhenDmOnly: false,
        }),
        resolveOriginTarget: async () => ({ to: "room:!ops:example.org" }),
        resolveApproverDmTargets: async () => [{ to: "user:@owner:example.org" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "matrix-dm:owner",
        target: { chatId: "matrix-dm:owner" },
      }),
      deliverTarget: async () => ({ chatId: "matrix-dm:owner", messageId: "m1" }),
      finalizeResolved: async () => {},
    });

    await runtime.start();
    await runtime.handleRequested({
      id: "req-4",
      request: {
        command: "echo hi",
        turnSourceChannel: "matrix",
        turnSourceTo: "room:!ops:example.org",
        turnSourceAccountId: "default",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    });

    expect(mockGatewayClientRequests).not.toHaveBeenCalledWith(
      "send",
      expect.objectContaining({
        idempotencyKey: "approval-route-notice:req-4",
      }),
    );
    await runtime.stop();
  });

  it("finalizes pending notices when a sibling runtime stops before reporting", async () => {
    mockGatewayClientStarts.mockReset();
    mockGatewayClientStops.mockReset();
    mockGatewayClientRequests.mockReset();
    mockCreateOperatorApprovalsGatewayClient.mockReset().mockResolvedValue({
      start: mockGatewayClientStarts,
      stop: mockGatewayClientStops,
      request: mockGatewayClientRequests,
    });
    const slackRuntime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-slack-stop-finalize",
      clientDisplayName: "Slack",
      channel: "slack",
      channelLabel: "Slack",
      cfg: {} as never,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: true,
          supportsApproverDmSurface: true,
          notifyOriginWhenDmOnly: true,
        }),
        resolveOriginTarget: async () => ({ to: "channel:C123", threadId: "1712345678.123456" }),
        resolveApproverDmTargets: async () => [{ to: "owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "slack-dm:owner",
        target: { chatId: "slack-dm:owner" },
      }),
      deliverTarget: async () => ({ chatId: "slack-dm:owner", messageId: "m1" }),
      finalizeResolved: async () => {},
    });
    const telegramRuntime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-telegram-stop-before-report",
      clientDisplayName: "Telegram",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {} as never,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: false,
          supportsApproverDmSurface: true,
        }),
        resolveApproverDmTargets: async () => [{ to: "owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "telegram-dm:owner",
        target: { chatId: "telegram-dm:owner" },
      }),
      deliverTarget: async () => ({ chatId: "telegram-dm:owner", messageId: "m2" }),
      finalizeResolved: async () => {},
    });

    await slackRuntime.start();
    await telegramRuntime.start();
    await slackRuntime.handleRequested({
      id: "req-5",
      request: {
        command: "echo hi",
        turnSourceChannel: "slack",
        turnSourceTo: "channel:C123",
        turnSourceAccountId: "default",
        turnSourceThreadId: "1712345678.123456",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    });
    await telegramRuntime.stop();

    expect(mockGatewayClientRequests).toHaveBeenCalledWith("send", {
      channel: "slack",
      to: "channel:C123",
      accountId: "default",
      threadId: "1712345678.123456",
      message: "Approval required. I sent the approval request to Slack DMs, not this chat.",
      idempotencyKey: "approval-route-notice:req-5",
    });
    await slackRuntime.stop();
  });

  it("does not let disabled sibling runtimes block route notices", async () => {
    mockGatewayClientStarts.mockReset();
    mockGatewayClientStops.mockReset();
    mockGatewayClientRequests.mockReset();
    mockCreateOperatorApprovalsGatewayClient.mockReset().mockResolvedValue({
      start: mockGatewayClientStarts,
      stop: mockGatewayClientStops,
      request: mockGatewayClientRequests,
    });
    const slackRuntime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-slack-disabled-sibling",
      clientDisplayName: "Slack",
      channel: "slack",
      channelLabel: "Slack",
      cfg: {} as never,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: true,
          supportsApproverDmSurface: true,
          notifyOriginWhenDmOnly: true,
        }),
        resolveOriginTarget: async () => ({ to: "channel:C123", threadId: "1712345678.123456" }),
        resolveApproverDmTargets: async () => [{ to: "owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "slack-dm:owner",
        target: { chatId: "slack-dm:owner" },
      }),
      deliverTarget: async () => ({ chatId: "slack-dm:owner", messageId: "m1" }),
      finalizeResolved: async () => {},
    });
    const disabledTelegramRuntime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-disabled-telegram-sibling",
      clientDisplayName: "Telegram",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {} as never,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: false,
          supportsApproverDmSurface: true,
        }),
        resolveApproverDmTargets: async () => [{ to: "owner" }],
      },
      isConfigured: () => false,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "telegram-dm:owner",
        target: { chatId: "telegram-dm:owner" },
      }),
      deliverTarget: async () => ({ chatId: "telegram-dm:owner", messageId: "m2" }),
      finalizeResolved: async () => {},
    });

    await disabledTelegramRuntime.start();
    await slackRuntime.start();
    await slackRuntime.handleRequested({
      id: "req-disabled-sibling",
      request: {
        command: "echo hi",
        turnSourceChannel: "slack",
        turnSourceTo: "channel:C123",
        turnSourceAccountId: "default",
        turnSourceThreadId: "1712345678.123456",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    });

    expect(mockGatewayClientRequests).toHaveBeenCalledWith("send", {
      channel: "slack",
      to: "channel:C123",
      accountId: "default",
      threadId: "1712345678.123456",
      message: "Approval required. I sent the approval request to Slack DMs, not this chat.",
      idempotencyKey: "approval-route-notice:req-disabled-sibling",
    });
    await slackRuntime.stop();
    await disabledTelegramRuntime.stop();
  });

  it("passes the resolved approval kind and pending content through native delivery hooks", async () => {
    const describeDeliveryCapabilities = vi.fn().mockReturnValue({
      enabled: true,
      preferredSurface: "approver-dm",
      supportsOriginSurface: false,
      supportsApproverDmSurface: true,
    });
    const resolveApproverDmTargets = vi
      .fn()
      .mockImplementation(({ approvalKind, accountId }) => [
        { to: `${approvalKind}:${accountId}` },
      ]);
    const buildPendingContent = vi.fn().mockResolvedValue("pending plugin");
    const prepareTarget = vi.fn().mockReturnValue({
      dedupeKey: "dm:plugin:secondary",
      target: { chatId: "plugin:secondary" },
    });
    const deliverTarget = vi
      .fn()
      .mockResolvedValue({ chatId: "plugin:secondary", messageId: "m1" });
    const finalizeResolved = vi.fn().mockResolvedValue(undefined);
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime",
      clientDisplayName: "Test",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {} as never,
      accountId: "secondary",
      eventKinds: ["exec", "plugin"] as const,
      nativeAdapter: {
        describeDeliveryCapabilities,
        resolveApproverDmTargets,
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent,
      prepareTarget,
      deliverTarget,
      finalizeResolved,
    });

    await runtime.handleRequested({
      id: "plugin:req-1",
      request: {
        title: "Plugin approval",
        description: "Allow access",
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    });
    await runtime.handleResolved({
      id: "plugin:req-1",
      decision: "allow-once",
      ts: 1,
    });

    expect(buildPendingContent).toHaveBeenCalledWith({
      request: expect.objectContaining({ id: "plugin:req-1" }),
      approvalKind: "plugin",
      nowMs: expect.any(Number),
    });
    expect(prepareTarget).toHaveBeenCalledWith({
      plannedTarget: {
        surface: "approver-dm",
        target: { to: "plugin:secondary" },
        reason: "preferred",
      },
      request: expect.objectContaining({ id: "plugin:req-1" }),
      approvalKind: "plugin",
      pendingContent: "pending plugin",
    });
    expect(deliverTarget).toHaveBeenCalledWith({
      plannedTarget: {
        surface: "approver-dm",
        target: { to: "plugin:secondary" },
        reason: "preferred",
      },
      preparedTarget: { chatId: "plugin:secondary" },
      request: expect.objectContaining({ id: "plugin:req-1" }),
      approvalKind: "plugin",
      pendingContent: "pending plugin",
    });
    expect(describeDeliveryCapabilities).toHaveBeenCalledWith({
      cfg: {} as never,
      accountId: "secondary",
      approvalKind: "plugin",
      request: expect.objectContaining({ id: "plugin:req-1" }),
    });
    expect(resolveApproverDmTargets).toHaveBeenCalledWith({
      cfg: {} as never,
      accountId: "secondary",
      approvalKind: "plugin",
      request: expect.objectContaining({ id: "plugin:req-1" }),
    });
    expect(finalizeResolved).toHaveBeenCalledWith({
      request: expect.objectContaining({ id: "plugin:req-1" }),
      resolved: expect.objectContaining({ id: "plugin:req-1", decision: "allow-once" }),
      entries: [{ chatId: "plugin:secondary", messageId: "m1" }],
    });
  });

  it("runs expiration through the shared runtime factory", async () => {
    vi.useFakeTimers();
    const finalizeExpired = vi.fn().mockResolvedValue(undefined);
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-expiry",
      clientDisplayName: "Test",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {} as never,
      nowMs: Date.now,
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: false,
          supportsApproverDmSurface: true,
        }),
        resolveApproverDmTargets: async () => [{ to: "owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async () => ({
        dedupeKey: "dm:owner",
        target: { chatId: "owner" },
      }),
      deliverTarget: async () => ({ chatId: "owner", messageId: "m1" }),
      finalizeResolved: async () => {},
      finalizeExpired,
    });

    await runtime.handleRequested({
      id: "req-1",
      request: {
        command: "echo hi",
      },
      createdAtMs: 0,
      expiresAtMs: Date.now() + 60_000,
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(finalizeExpired).toHaveBeenCalledWith({
      request: expect.objectContaining({ id: "req-1" }),
      entries: [{ chatId: "owner", messageId: "m1" }],
    });
    vi.useRealTimers();
  });
});
