/**
 * Tests approval auth helper decisions and implicit same-chat authorization markers.
 */
import { describe, expect, it } from "vitest";
import {
  createChannelApprovalAuth,
  createResolvedApproverActionAuthAdapter,
  isImplicitSameChatApprovalAuthorization,
} from "./approval-auth-helpers.js";

describe("createChannelApprovalAuth", () => {
  it("shares resolution, sender checks, and action authorization", () => {
    const auth = createChannelApprovalAuth({
      channelLabel: "Example",
      resolveInputs: () => ({ allowFrom: [" OWNER ", "owner"], defaultTo: "backup" }),
      normalizeApprover: (value) => String(value).trim().toLowerCase() || undefined,
    });

    expect(auth.resolveApprovers({ cfg: {} })).toEqual(["owner", "backup"]);
    expect(auth.isAuthorizedSender({ cfg: {}, senderId: "OWNER" })).toBe(true);
    expect(
      auth.approvalAuth.authorizeActorAction({
        cfg: {},
        senderId: "attacker",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Example.",
    });
  });

  it("supports channel-owned wildcard authorization without broadcasting a wildcard target", () => {
    const auth = createChannelApprovalAuth({
      channelLabel: "Example",
      resolveInputs: () => ({ allowFrom: ["*"] }),
      normalizeApprover: (value) => (value === "*" ? undefined : String(value)),
      isWildcardAuthorized: ({ purpose, senderId, inputs }) =>
        purpose === "sender" && Boolean(senderId) && inputs.allowFrom?.includes("*") === true,
    });

    expect(auth.resolveApprovers({ cfg: {} })).toEqual([]);
    expect(auth.isAuthorizedSender({ cfg: {}, senderId: "anyone" })).toBe(true);
    expect(auth.isAuthorizedSender({ cfg: {} })).toBe(false);
    expect(
      auth.approvalAuth.authorizeActorAction({
        cfg: {},
        senderId: "anyone",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });
});

describe("createResolvedApproverActionAuthAdapter", () => {
  it("allows matching normalized approvers and rejects others", () => {
    const auth = createResolvedApproverActionAuthAdapter({
      channelLabel: "Signal",
      resolveApprovers: () => ["uuid:owner"],
      normalizeSenderId: (value) => value.trim().toLowerCase(),
    });
    const authorize = (senderId: string) =>
      auth.authorizeActorAction({ cfg: {}, senderId, action: "approve", approvalKind: "plugin" });

    expect(authorize(" UUID:OWNER ")).toEqual({ authorized: true });
    expect(authorize("uuid:attacker")).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Signal.",
    });
  });

  it("marks empty-approver fallback auth as implicit", () => {
    const auth = createResolvedApproverActionAuthAdapter({
      channelLabel: "Signal",
      resolveApprovers: () => [],
    });
    const result = auth.authorizeActorAction({
      cfg: {},
      senderId: "uuid:attacker",
      action: "approve",
      approvalKind: "exec",
    });

    expect(result).toEqual({ authorized: true });
    expect(isImplicitSameChatApprovalAuthorization(result)).toBe(true);
  });

  it("does not mark configured-approver auth as implicit", () => {
    const auth = createResolvedApproverActionAuthAdapter({
      channelLabel: "Signal",
      resolveApprovers: () => ["uuid:owner"],
    });
    const result = auth.authorizeActorAction({
      cfg: {},
      senderId: "uuid:owner",
      action: "approve",
      approvalKind: "exec",
    });

    expect(result).toEqual({ authorized: true });
    expect(isImplicitSameChatApprovalAuthorization(result)).toBe(false);
  });
});
