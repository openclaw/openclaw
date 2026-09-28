import { describe, expect, it } from "vitest";
import { capturePluginApprovalSource } from "./plugin-approval-source.js";

const authorizedSlackMessage = {
  context: {
    InboundAccessAuthorized: true,
    ApprovalSource: {
      channel: "slack",
      senderId: "U123",
      senderName: "Lightning McQueen",
      workspaceId: "T123",
      conversationKind: "direct" as const,
      includeUserMessageExcerpt: true,
    },
    RawBody: "Please render alpha to beta",
  },
  channel: "slack",
  isHeartbeat: false,
  isRoomEvent: false,
  reusesTurnRecorder: false,
};

describe("plugin approval source snapshot", () => {
  it("captures the admitted Slack sender and redacts before truncating the original text", () => {
    expect(capturePluginApprovalSource(authorizedSlackMessage)).toEqual({
      channel: "slack",
      senderId: "U123",
      senderName: "Lightning McQueen",
      workspaceId: "T123",
      conversationKind: "direct",
      userMessageExcerpt: "Please render alpha to beta",
    });

    const secret = `ghp_${"a".repeat(100)}`;
    const source = capturePluginApprovalSource({
      ...authorizedSlackMessage,
      context: {
        ...authorizedSlackMessage.context,
        RawBody: `${"x".repeat(290)} ${secret} after`,
      },
    });
    expect(source?.userMessageExcerpt?.length).toBeLessThanOrEqual(320);
    expect(source?.userMessageExcerpt).not.toContain(secret);
    expect(source?.senderName).toBe("Lightning McQueen");
  });

  it("keeps an admitted source without an excerpt when its channel has not opted in", () => {
    const source = capturePluginApprovalSource({
      ...authorizedSlackMessage,
      context: {
        ...authorizedSlackMessage.context,
        ApprovalSource: {
          channel: "telegram",
          senderId: "1234",
          senderName: "Pat",
          conversationKind: "direct",
        },
      },
      channel: "telegram",
    });
    expect(source).toEqual({
      channel: "telegram",
      senderId: "1234",
      senderName: "Pat",
      conversationKind: "direct",
    });
  });

  it("retains a valid long Matrix sender ID for the requester notice", () => {
    const senderId = `@${"a".repeat(52)}:example.org`;
    const source = capturePluginApprovalSource({
      ...authorizedSlackMessage,
      context: {
        ...authorizedSlackMessage.context,
        ApprovalSource: { channel: "matrix", senderId, conversationKind: "direct" },
      },
      channel: "matrix",
    });
    expect(source).toEqual({ channel: "matrix", senderId, conversationKind: "direct" });
  });

  it("drops unsafe or oversized provider identifiers before they reach the approval card", () => {
    const withSource = (
      patch: Partial<NonNullable<typeof authorizedSlackMessage.context.ApprovalSource>>,
    ) =>
      capturePluginApprovalSource({
        ...authorizedSlackMessage,
        context: {
          ...authorizedSlackMessage.context,
          ApprovalSource: { ...authorizedSlackMessage.context.ApprovalSource, ...patch },
        },
      });

    expect(withSource({ senderId: "U".repeat(256) })).toBeUndefined();
    expect(withSource({ senderId: "U123\n" })).toBeUndefined();
    expect(withSource({ channel: "slack\u200b" })).toBeUndefined();
    expect(withSource({ workspaceId: "T".repeat(65) })).not.toHaveProperty("workspaceId");
  });

  it.each([
    {
      reason: "channel without owner-supplied approval source",
      patch: { context: { ...authorizedSlackMessage.context, ApprovalSource: undefined } },
    },
    { reason: "different channel", patch: { channel: "telegram" } },
    {
      reason: "unadmitted",
      patch: { context: { ...authorizedSlackMessage.context, InboundAccessAuthorized: false } },
    },
    {
      reason: "self",
      patch: { context: { ...authorizedSlackMessage.context, SenderIsSelf: true } },
    },
    { reason: "internal", patch: { provenance: { kind: "internal_system" as const } } },
    { reason: "reused turn", patch: { reusesTurnRecorder: true } },
    { reason: "room event", patch: { isRoomEvent: true } },
  ])("omits $reason input", ({ patch }) => {
    expect(capturePluginApprovalSource({ ...authorizedSlackMessage, ...patch })).toBeUndefined();
  });
});
