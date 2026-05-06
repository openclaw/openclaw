import { describe, expect, it } from "vitest";
import type { ChannelApprovalNativeAdapter } from "../channels/plugins/types.adapters.js";
import { resolveChannelNativeApprovalDeliveryPlan } from "./approval-native-delivery.js";

const execRequest = {
  id: "approval-1",
  request: {
    command: "uname -a",
  },
  createdAtMs: 0,
  expiresAtMs: 120_000,
};

describe("resolveChannelNativeApprovalDeliveryPlan", () => {
  it("prefers the origin surface when configured and available", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "origin",
        supportsOriginSurface: true,
        supportsApproverDmSurface: true,
      }),
      resolveOriginTarget: async () => ({ to: "origin-chat", threadId: "42" }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }],
    };

    const plan = await resolveChannelNativeApprovalDeliveryPlan({
      cfg: {} as never,
      approvalKind: "exec",
      request: execRequest,
      adapter,
    });

    expect(plan.notifyOriginWhenDmOnly).toBe(false);
    expect(plan.targets).toEqual([
      {
        surface: "origin",
        target: { to: "origin-chat", threadId: "42" },
        reason: "preferred",
      },
    ]);
  });

  it("does not fall back to approver DMs when origin-only delivery is unavailable", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "origin",
        supportsOriginSurface: true,
        supportsApproverDmSurface: true,
      }),
      resolveOriginTarget: async () => null,
      resolveApproverDmTargets: async () => [{ to: "approver-1" }, { to: "approver-2" }],
    };

    const plan = await resolveChannelNativeApprovalDeliveryPlan({
      cfg: {} as never,
      approvalKind: "exec",
      request: execRequest,
      adapter,
    });

    expect(plan.targets).toEqual([]);
  });

  it("falls back to approver DMs when origin is unsupported", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "approver-dm",
        supportsOriginSurface: false,
        supportsApproverDmSurface: true,
      }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }, { to: "approver-2" }],
    };

    const plan = await resolveChannelNativeApprovalDeliveryPlan({
      cfg: {} as never,
      approvalKind: "exec",
      request: execRequest,
      adapter,
    });

    expect(plan.targets).toEqual([
      {
        surface: "approver-dm",
        target: { to: "approver-1" },
        reason: "preferred",
      },
      {
        surface: "approver-dm",
        target: { to: "approver-2" },
        reason: "preferred",
      },
    ]);
  });

  it("requests an origin redirect notice when DM-only delivery has an origin context", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "approver-dm",
        supportsOriginSurface: true,
        supportsApproverDmSurface: true,
        notifyOriginWhenDmOnly: true,
      }),
      resolveOriginTarget: async () => ({ to: "origin-chat" }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }],
    };

    const plan = await resolveChannelNativeApprovalDeliveryPlan({
      cfg: {} as never,
      approvalKind: "plugin",
      request: {
        ...execRequest,
        id: "plugin:approval-1",
        request: {
          title: "Plugin approval",
          description: "Needs access",
        },
      },
      adapter,
    });

    expect(plan.originTarget).toEqual({ to: "origin-chat" });
    expect(plan.notifyOriginWhenDmOnly).toBe(true);
    expect(plan.targets).toEqual([
      {
        surface: "approver-dm",
        target: { to: "approver-1" },
        reason: "preferred",
      },
    ]);
  });

  it("dedupes duplicate origin and DM targets when both surfaces converge", async () => {
    const adapter: ChannelApprovalNativeAdapter = {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface: "both",
        supportsOriginSurface: true,
        supportsApproverDmSurface: true,
      }),
      resolveOriginTarget: async () => ({ to: "shared-chat" }),
      resolveApproverDmTargets: async () => [{ to: "shared-chat" }, { to: "approver-2" }],
    };

    const plan = await resolveChannelNativeApprovalDeliveryPlan({
      cfg: {} as never,
      approvalKind: "exec",
      request: execRequest,
      adapter,
    });

    expect(plan.targets).toEqual([
      {
        surface: "origin",
        target: { to: "shared-chat" },
        reason: "preferred",
      },
      {
        surface: "approver-dm",
        target: { to: "approver-2" },
        reason: "preferred",
      },
    ]);
  });
});
