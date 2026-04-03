import { describe, expect, it, vi } from "vitest";
import type { ChannelApprovalNativeAdapter } from "../channels/plugins/types.adapters.js";
import {
  createChannelNativeApprovalRuntime,
  deliverApprovalRequestViaChannelNativePlan,
} from "./approval-native-runtime.js";

const execRequest = {
  id: "approval-1",
  request: {
    command: "uname -a",
  },
  createdAtMs: 0,
  expiresAtMs: 120_000,
};

describe("deliverApprovalRequestViaChannelNativePlan", () => {
  it("sends an origin notice and dedupes converged prepared targets", async () => {
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
    const sendOriginNotice = vi.fn().mockResolvedValue(undefined);
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

    const entries = await deliverApprovalRequestViaChannelNativePlan({
      cfg: {} as never,
      approvalKind: "exec",
      request: execRequest,
      adapter,
      sendOriginNotice: async ({ originTarget }) => {
        await sendOriginNotice(originTarget);
      },
      prepareTarget,
      deliverTarget,
      onDuplicateSkipped,
    });

    expect(sendOriginNotice).toHaveBeenCalledWith({ to: "origin-room" });
    expect(prepareTarget).toHaveBeenCalledTimes(2);
    expect(deliverTarget).toHaveBeenCalledTimes(1);
    expect(onDuplicateSkipped).toHaveBeenCalledTimes(1);
    expect(entries).toEqual([{ channelId: "shared-dm" }]);
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

    const entries = await deliverApprovalRequestViaChannelNativePlan({
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
    expect(entries).toEqual([{ channelId: "approver-2" }]);
  });
});

describe("createChannelNativeApprovalRuntime", () => {
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
