import { describe, expect, it } from "vitest";
import {
  createChannelApprovalAuth,
  createResolvedApproverActionAuthAdapter,
  isImplicitSameChatApprovalAuthorization,
} from "./approval-auth-helpers.js";

type ApprovalAuth = ReturnType<typeof createResolvedApproverActionAuthAdapter>;
const authorize = (
  auth: ApprovalAuth,
  senderId: string,
  approvalKind: "exec" | "plugin" = "exec",
) => auth.authorizeActorAction({ cfg: {}, senderId, action: "approve", approvalKind });
const signalAuth = (approvers: string[], normalizeSenderId?: (value: string) => string) =>
  createResolvedApproverActionAuthAdapter({
    channelLabel: "Signal",
    resolveApprovers: () => approvers,
    normalizeSenderId,
  });

describe("createChannelApprovalAuth", () => {
  it("shares resolution, sender checks, and action authorization", () => {
    const auth = createChannelApprovalAuth({
      channelLabel: "Example",
      resolveInputs: () => ({ allowFrom: [" OWNER ", "owner"], defaultTo: "backup" }),
      normalizeApprover: (value) => String(value).trim().toLowerCase() || undefined,
    });

    expect(auth.resolveApprovers({ cfg: {} })).toEqual(["owner", "backup"]);
    expect(auth.isAuthorizedSender({ cfg: {}, senderId: "OWNER" })).toBe(true);
    expect(authorize(auth.approvalAuth, "attacker", "plugin")).toEqual({
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
    expect(authorize(auth.approvalAuth, "anyone")).toEqual({ authorized: true });
  });
});

describe("createResolvedApproverActionAuthAdapter", () => {
  it("allows matching normalized approvers and rejects others", () => {
    const auth = signalAuth(["uuid:owner"], (value) => value.trim().toLowerCase());

    expect(authorize(auth, " UUID:OWNER ", "plugin")).toEqual({ authorized: true });
    expect(authorize(auth, "uuid:attacker", "plugin")).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on Signal.",
    });
  });

  it.each([
    [[], "uuid:attacker", true],
    [["uuid:owner"], "uuid:owner", false],
  ] satisfies Array<[string[], string, boolean]>)(
    "marks %j approvers / %s sender as implicit: %s",
    (approvers, sender, implicit) => {
      const result = authorize(signalAuth(approvers), sender);
      expect(result).toEqual({ authorized: true });
      expect(isImplicitSameChatApprovalAuthorization(result)).toBe(implicit);
    },
  );
});
