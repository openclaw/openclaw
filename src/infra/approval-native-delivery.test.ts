import { describe, expect, it } from "vitest";
import type { ChannelApprovalNativeAdapter } from "../channels/plugins/types.adapters.js";
import { resolveChannelNativeApprovalDeliveryPlan } from "./approval-native-delivery.js";

type PlanParams = Parameters<typeof resolveChannelNativeApprovalDeliveryPlan>[0];
const execRequest = {
  id: "approval-1",
  request: { command: "uname -a" },
  createdAtMs: 0,
  expiresAtMs: 120_000,
};

function planDelivery(
  preferredSurface: "origin" | "approver-dm" | "both",
  overrides: Partial<ChannelApprovalNativeAdapter> = {},
  params: Partial<Pick<PlanParams, "request" | "approvalKind">> = {},
) {
  return resolveChannelNativeApprovalDeliveryPlan({
    cfg: {},
    approvalKind: "exec",
    request: execRequest,
    ...params,
    adapter: {
      describeDeliveryCapabilities: () => ({
        enabled: true,
        preferredSurface,
        supportsOriginSurface: true,
        supportsApproverDmSurface: true,
        notifyOriginWhenDmOnly: preferredSurface === "approver-dm",
      }),
      resolveOriginTarget: async () => ({ to: "origin-chat" }),
      resolveApproverDmTargets: async () => [{ to: "approver-1" }],
      ...overrides,
    },
  });
}

describe("resolveChannelNativeApprovalDeliveryPlan", () => {
  it("prefers the origin surface when configured and available", async () => {
    const plan = await planDelivery("origin", {
      resolveOriginTarget: async () => ({ to: "origin-chat", threadId: "42" }),
    });
    expect(plan.notifyOriginWhenDmOnly).toBe(false);
    expect(plan.targets).toEqual([
      { surface: "origin", target: { to: "origin-chat", threadId: "42" }, reason: "preferred" },
    ]);
  });

  it("falls back to approver DMs when origin delivery is unavailable", async () => {
    const plan = await planDelivery("origin", {
      resolveOriginTarget: async () => null,
      resolveApproverDmTargets: async () => [{ to: "approver-1" }, { to: "approver-2" }],
    });
    expect(plan.targets).toEqual([
      { surface: "approver-dm", target: { to: "approver-1" }, reason: "fallback" },
      { surface: "approver-dm", target: { to: "approver-2" }, reason: "fallback" },
    ]);
  });

  it("requests an origin redirect notice when DM-only delivery has an origin context", async () => {
    const plan = await planDelivery(
      "approver-dm",
      {},
      {
        approvalKind: "plugin",
        request: {
          ...execRequest,
          id: "plugin:approval-1",
          request: { title: "Plugin approval", description: "Needs access" },
        },
      },
    );
    expect(plan.originTarget).toEqual({ to: "origin-chat" });
    expect(plan.notifyOriginWhenDmOnly).toBe(true);
    expect(plan.targets).toEqual([
      { surface: "approver-dm", target: { to: "approver-1" }, reason: "preferred" },
    ]);
  });

  it("dedupes duplicate origin and DM targets when both surfaces converge", async () => {
    const plan = await planDelivery("both", {
      resolveOriginTarget: async () => ({ to: "shared-chat" }),
      resolveApproverDmTargets: async () => [{ to: "shared-chat" }, { to: "approver-2" }],
    });
    expect(plan.targets).toEqual([
      { surface: "origin", target: { to: "shared-chat" }, reason: "preferred" },
      { surface: "approver-dm", target: { to: "approver-2" }, reason: "preferred" },
    ]);
  });
});
