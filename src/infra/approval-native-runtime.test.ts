// Covers native approval runtime delivery and resolution.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelApprovalNativeAdapter } from "../channels/plugins/types.adapters.js";
import { createChannelNativeApprovalRuntime as createChannelNativeApprovalRuntimeRaw } from "./approval-native-runtime.js";

const hoisted = vi.hoisted(() => ({
  callGatewayLeastPrivilege: vi.fn(async () => ({ ok: true })),
  createOperatorApprovalsGatewayClient: vi.fn(
    async (params: { onHelloOk?: (hello: unknown) => void }) => {
      queueMicrotask(() => params.onHelloOk?.({ type: "hello-ok" }));
      return {
        request: vi.fn(async () => ({ ok: true })),
        stop: vi.fn(),
      };
    },
  ),
  startGatewayClientWhenEventLoopReady: vi.fn(async () => ({
    ready: true,
    aborted: false,
  })),
}));

vi.mock("../gateway/call.js", () => ({
  callGatewayLeastPrivilege: hoisted.callGatewayLeastPrivilege,
}));

vi.mock("../gateway/operator-approvals-client.js", () => ({
  createOperatorApprovalsGatewayClient: hoisted.createOperatorApprovalsGatewayClient,
}));

vi.mock("../../packages/gateway-client/src/readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: hoisted.startGatewayClientWhenEventLoopReady,
}));

const execRequest = {
  id: "approval-1",
  request: {
    command: "uname -a",
  },
  createdAtMs: 0,
  expiresAtMs: 120_000,
};

const approvalRuntimes: Array<ReturnType<typeof createChannelNativeApprovalRuntimeRaw>> = [];

function createChannelNativeApprovalRuntime(
  params: Parameters<typeof createChannelNativeApprovalRuntimeRaw>[0],
) {
  const runtime = createChannelNativeApprovalRuntimeRaw(params);
  approvalRuntimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(approvalRuntimes.splice(0).map((runtime) => runtime.stop()));
  hoisted.callGatewayLeastPrivilege.mockClear();
  hoisted.createOperatorApprovalsGatewayClient.mockClear();
  hoisted.startGatewayClientWhenEventLoopReady.mockClear();
  vi.useRealTimers();
});

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function mockCallArg(mock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  const arg = mock.mock.calls[index]?.[0];
  return requireRecord(arg);
}

describe("createChannelNativeApprovalRuntime", () => {
  it("dedupes converged prepared targets", async () => {
    vi.useFakeTimers();
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
    const finalizeResolved = vi.fn(async () => undefined);

    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-dedupe",
      clientDisplayName: "Test",
      cfg: {} as never,
      nowMs: () => 0,
      nativeAdapter: adapter,
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: () => "pending exec",
      prepareTarget,
      deliverTarget,
      onDuplicateSkipped,
      finalizeResolved,
    });
    await runtime.handleRequested(execRequest);
    await runtime.handleResolved({ id: execRequest.id, decision: "allow-once", ts: 1 });

    expect(prepareTarget).toHaveBeenCalledTimes(2);
    expect(deliverTarget).toHaveBeenCalledTimes(1);
    expect(onDuplicateSkipped).toHaveBeenCalledTimes(1);
    expect(finalizeResolved).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ entries: [{ channelId: "shared-dm" }] }),
    );
  });

  it("continues after per-target delivery failures", async () => {
    vi.useFakeTimers();
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
    const finalizeResolved = vi.fn(async () => undefined);
    const deliverTarget = vi
      .fn()
      .mockImplementation(async ({ preparedTarget }: { preparedTarget: { channelId: string } }) => {
        if (preparedTarget.channelId === "approver-1") {
          throw new Error("boom");
        }
        return { channelId: preparedTarget.channelId };
      });

    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-delivery-failure",
      clientDisplayName: "Test",
      cfg: {} as never,
      nowMs: () => 0,
      nativeAdapter: adapter,
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: () => "pending exec",
      prepareTarget: ({ plannedTarget }) => ({
        dedupeKey: plannedTarget.target.to,
        target: { channelId: plannedTarget.target.to },
      }),
      deliverTarget,
      onDeliveryError,
      finalizeResolved,
    });
    await runtime.handleRequested(execRequest);
    await runtime.handleResolved({ id: execRequest.id, decision: "allow-once", ts: 1 });

    expect(onDeliveryError).toHaveBeenCalledTimes(1);
    expect(finalizeResolved).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ entries: [{ channelId: "approver-2" }] }),
    );
  });

  it("selects and expires system-agent approval targets through the native lifecycle", async () => {
    const deliverTarget = vi.fn().mockResolvedValue({ chatId: "123", messageId: "m1" });
    const finalizeExpired = vi.fn().mockResolvedValue(undefined);
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/system-agent-native-runtime",
      clientDisplayName: "Test",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {} as never,
      accountId: "default",
      eventKinds: ["system-agent"],
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "origin",
          supportsOriginSurface: true,
          supportsApproverDmSurface: false,
        }),
        resolveOriginTarget: () => ({ to: "123" }),
      },
      isConfigured: () => true,
      shouldHandle: vi.fn().mockReturnValue(true),
      buildPendingContent: vi.fn().mockResolvedValue({ text: "pending" }),
      prepareTarget: ({ plannedTarget }) => ({
        dedupeKey: plannedTarget.target.to,
        target: { chatId: plannedTarget.target.to },
      }),
      deliverTarget,
      finalizeResolved: vi.fn().mockResolvedValue(undefined),
      finalizeExpired,
    });

    await runtime.handleRequested({
      id: "system-agent:native-1",
      request: {
        title: "OpenClaw change",
        description: "restart the Gateway",
        command: "restart the Gateway",
        proposalHash: "a".repeat(64),
        allowedDecisions: ["allow-once", "deny"],
        sessionId: "delegation-1",
      },
      createdAtMs: 0,
      expiresAtMs: 2_000,
    });

    expect(deliverTarget).toHaveBeenCalledWith(
      expect.objectContaining({ approvalKind: "system-agent" }),
    );
    await runtime.handleExpired("system-agent:native-1");
    expect(finalizeExpired).toHaveBeenCalledOnce();
  });

  it("honors the deprecated approval kind compatibility override", async () => {
    const resolveApprovalKind = vi.fn().mockReturnValue("exec");
    const buildPendingContent = vi.fn().mockResolvedValue("pending");
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-legacy-kind",
      clientDisplayName: "Test",
      cfg: {} as never,
      resolveApprovalKind,
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent,
      prepareTarget: async () => null,
      deliverTarget: async () => null,
      finalizeResolved: async () => {},
    });

    const request = {
      id: "legacy-owned-id",
      request: {
        title: "Plugin approval",
        description: "Allow access",
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    } as const;
    const normalizedRequest = { ...request, approvalKind: "plugin" as const };
    await runtime.handleRequested(request);

    expect(resolveApprovalKind).toHaveBeenCalledWith(normalizedRequest);
    expect(buildPendingContent).toHaveBeenCalledWith(
      expect.objectContaining({ request: normalizedRequest, approvalKind: "exec" }),
    );
  });

  it("sends route notices over least-privilege gateway calls", async () => {
    const runtime = createChannelNativeApprovalRuntime({
      label: "test/native-runtime-route-notice",
      clientDisplayName: "Test",
      channel: "slack",
      channelLabel: "Slack",
      cfg: { gateway: { auth: { token: "configured-token" } } } as never,
      accountId: "default",
      nativeAdapter: {
        describeDeliveryCapabilities: () => ({
          enabled: true,
          preferredSurface: "approver-dm",
          supportsOriginSurface: true,
          supportsApproverDmSurface: true,
          notifyOriginWhenDmOnly: true,
        }),
        resolveOriginTarget: async () => ({
          to: "channel:C123",
          threadId: "1712345678.123456",
        }),
        resolveApproverDmTargets: async () => [{ to: "user:owner" }],
      },
      isConfigured: () => true,
      shouldHandle: () => true,
      buildPendingContent: async () => "pending exec",
      prepareTarget: async ({ plannedTarget }) => ({
        dedupeKey: plannedTarget.target.to,
        target: { chatId: plannedTarget.target.to },
      }),
      deliverTarget: async () => ({ chatId: "user:owner", messageId: "m1" }),
      finalizeResolved: async () => {},
    });

    await runtime.start();
    try {
      await runtime.handleRequested({
        id: "approval-route-notice",
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
    } finally {
      await runtime.stop();
    }

    expect(hoisted.callGatewayLeastPrivilege).toHaveBeenCalledWith(
      expect.objectContaining({
        config: { gateway: { auth: { token: "configured-token" } } },
        method: "send",
        clientName: "gateway-client",
        mode: "backend",
        params: {
          channel: "slack",
          to: "channel:C123",
          accountId: "default",
          threadId: "1712345678.123456",
          message: "Approval required. I sent the approval request to Slack DMs, not this chat.",
          idempotencyKey: "approval-route-notice:approval-route-notice",
        },
      }),
    );
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

    const expiredCall = mockCallArg(finalizeExpired);
    expect(requireRecord(expiredCall.request).id).toBe("req-1");
    expect(expiredCall.entries).toEqual([{ chatId: "owner", messageId: "m1" }]);
    vi.useRealTimers();
  });
});
