import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  loadConfig: () => ({}),
  resolveGatewayPort: () => 18789,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

import { requestPluginApproval, requestSingleHookApproval } from "./hook-approval.js";
import { PluginApprovalResolutions } from "./hook-types.js";

describe("requestPluginApproval", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("uses an unbound backend gateway client for plugin approval RPCs", async () => {
    callGatewayMock.mockImplementation(async (opts: { method?: unknown }) => {
      if (opts.method === "plugin.approval.request") {
        return { id: "plugin:approval-1" };
      }
      if (opts.method === "plugin.approval.waitDecision") {
        return { id: "plugin:approval-1", decision: PluginApprovalResolutions.ALLOW_ONCE };
      }
      throw new Error(`unexpected method ${String(opts.method)}`);
    });

    const result = await requestPluginApproval({
      pluginId: "confirm-before-run",
      title: "Approve agent run",
      description: "Start this agent run?",
    });

    expect(result.decision).toBe(PluginApprovalResolutions.ALLOW_ONCE);
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "plugin.approval.request",
        deviceIdentity: null,
        scopes: ["operator.approvals"],
        params: expect.objectContaining({
          allowedDecisions: undefined,
        }),
      }),
    );
    expect(callGatewayMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "plugin.approval.waitDecision",
        deviceIdentity: null,
        scopes: ["operator.approvals"],
      }),
    );
  });

  it("limits lifecycle hook approvals to one-shot allow or deny decisions", async () => {
    callGatewayMock.mockImplementation(async (opts: { method?: unknown }) => {
      if (opts.method === "plugin.approval.request") {
        return { id: "plugin:approval-1", decision: "allow-always" };
      }
      throw new Error(`unexpected method ${String(opts.method)}`);
    });

    const result = await requestSingleHookApproval({
      hookPoint: "llm_message_end",
      pluginId: "confirm-before-run",
      decision: {
        outcome: "ask",
        reason: "needs review",
        title: "Approve output",
        description: "Approve this assistant message?",
      },
    });

    expect(result).toBe(PluginApprovalResolutions.ALLOW_ONCE);
    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "plugin.approval.request",
        params: expect.objectContaining({
          allowedDecisions: [PluginApprovalResolutions.ALLOW_ONCE, PluginApprovalResolutions.DENY],
        }),
      }),
    );
  });
});
