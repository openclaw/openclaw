import { describe, expect, it } from "vitest";
import { createResolvedApproverActionAuthAdapter } from "./approval-auth-helpers.js";

describe("createResolvedApproverActionAuthAdapter", () => {
  it("falls back to generic same-chat auth when no approvers resolve", () => {
    const auth = createResolvedApproverActionAuthAdapter({
      channelLabel: "Slack",
      resolveApprovers: () => [],
    });

    expect(
      auth.authorizeActorAction({
        cfg: {},
        senderId: "U_OWNER",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });

  it("allows matching normalized approvers and rejects others", () => {
    const auth = createResolvedApproverActionAuthAdapter({
      channelLabel: "Signal",
      resolveApprovers: () => ["uuid:owner"],
      normalizeSenderId: (value) => value.trim().toLowerCase(),
    });

    expect(
      auth.authorizeActorAction({
        cfg: {},
        senderId: " UUID:OWNER ",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });

    expect(
      auth.authorizeActorAction({
        cfg: {},
        senderId: "uuid:attacker",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Signal.",
    });
  });
});
