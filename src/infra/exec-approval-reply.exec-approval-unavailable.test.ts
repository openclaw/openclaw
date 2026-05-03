import { describe, expect, it } from "vitest";
import { buildExecApprovalUnavailableReplyPayload } from "./exec-approval-reply.js";

describe("buildExecApprovalUnavailableReplyPayload — channelData marker", () => {
  it("includes execApprovalUnavailable channelData for no-approval-route", () => {
    const payload = buildExecApprovalUnavailableReplyPayload({
      reason: "no-approval-route",
    });
    expect(payload.channelData).toBeDefined();
    expect((payload.channelData as Record<string, unknown>).execApprovalUnavailable).toEqual({
      reason: "no-approval-route",
    });
  });

  it("includes execApprovalUnavailable channelData for initiating-platform-disabled", () => {
    const payload = buildExecApprovalUnavailableReplyPayload({
      reason: "initiating-platform-disabled",
      channelLabel: "WhatsApp",
    });
    expect(payload.channelData).toBeDefined();
    expect((payload.channelData as Record<string, unknown>).execApprovalUnavailable).toEqual({
      reason: "initiating-platform-disabled",
    });
  });

  it("includes execApprovalUnavailable channelData for initiating-platform-unsupported", () => {
    const payload = buildExecApprovalUnavailableReplyPayload({
      reason: "initiating-platform-unsupported",
    });
    expect(payload.channelData).toBeDefined();
    expect((payload.channelData as Record<string, unknown>).execApprovalUnavailable).toEqual({
      reason: "initiating-platform-unsupported",
    });
  });

  it("includes channelData with params.reason (not literal) for sentApproverDms path", () => {
    const payload = buildExecApprovalUnavailableReplyPayload({
      reason: "no-approval-route",
      sentApproverDms: true,
    });
    expect(payload.channelData).toBeDefined();
    const cd = payload.channelData as Record<string, unknown>;
    expect(cd.execApprovalUnavailable).toEqual({
      reason: "no-approval-route",
    });
    // Verify we use the typed reason, not a string literal
    expect((cd.execApprovalUnavailable as Record<string, unknown>).reason).toBe("no-approval-route");
  });

  it("does NOT include execApproval (only execApprovalUnavailable)", () => {
    const payload = buildExecApprovalUnavailableReplyPayload({
      reason: "no-approval-route",
    });
    const cd = payload.channelData as Record<string, unknown>;
    expect(cd.execApproval).toBeUndefined();
    expect(cd.execApprovalUnavailable).toBeDefined();
  });

  it("preserves text content alongside channelData marker", () => {
    const payload = buildExecApprovalUnavailableReplyPayload({
      reason: "initiating-platform-disabled",
      channelLabel: "WhatsApp",
      warningText: "⚠️ Warning",
    });
    expect(payload.text).toContain("⚠️ Warning");
    expect(payload.text).toContain("WhatsApp");
    expect(payload.channelData).toBeDefined();
  });
});
