// Covers visible-reply config schema parsing and defaults.
import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("visible reply config schema", () => {
  it("coerces boolean global visibleReplies values to the enum contract", () => {
    const automatic = validateConfigObjectRaw({
      messages: {
        visibleReplies: true,
      },
    });
    const toolOnly = validateConfigObjectRaw({
      messages: {
        visibleReplies: false,
      },
    });

    expect(automatic.ok).toBe(true);
    expect(toolOnly.ok).toBe(true);
    if (automatic.ok) {
      expect(automatic.config.messages?.visibleReplies).toBe("automatic");
    }
    if (toolOnly.ok) {
      expect(toolOnly.config.messages?.visibleReplies).toBe("message_tool");
    }
  });

  it("coerces boolean groupChat visibleReplies values to the enum contract", () => {
    const automatic = validateConfigObjectRaw({
      messages: {
        groupChat: {
          visibleReplies: true,
        },
      },
    });
    const toolOnly = validateConfigObjectRaw({
      messages: {
        groupChat: {
          visibleReplies: false,
        },
      },
    });

    expect(automatic.ok).toBe(true);
    expect(toolOnly.ok).toBe(true);
    if (automatic.ok) {
      expect(automatic.config.messages?.groupChat?.visibleReplies).toBe("automatic");
    }
    if (toolOnly.ok) {
      expect(toolOnly.config.messages?.groupChat?.visibleReplies).toBe("message_tool");
    }
  });

  it("keeps invalid visibleReplies values rejected", () => {
    const result = validateConfigObjectRaw({
      messages: {
        visibleReplies: "visible",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const visibleRepliesIssue = result.issues.find(
        (issue) => issue.path === "messages.visibleReplies",
      );
      expect(visibleRepliesIssue?.path).toBe("messages.visibleReplies");
    }
  });

  it("accepts the opt-in strandedReplyRecovery flag", () => {
    const enabled = validateConfigObjectRaw({
      messages: {
        strandedReplyRecovery: true,
      },
    });
    const disabled = validateConfigObjectRaw({
      messages: {
        strandedReplyRecovery: false,
      },
    });

    expect(enabled.ok).toBe(true);
    expect(disabled.ok).toBe(true);
    if (enabled.ok) {
      expect(enabled.config.messages?.strandedReplyRecovery).toBe(true);
    }
    if (disabled.ok) {
      expect(disabled.config.messages?.strandedReplyRecovery).toBe(false);
    }
  });

  it("rejects non-boolean strandedReplyRecovery values", () => {
    const result = validateConfigObjectRaw({
      messages: {
        strandedReplyRecovery: "yes",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find(
        (candidate) => candidate.path === "messages.strandedReplyRecovery",
      );
      expect(issue?.path).toBe("messages.strandedReplyRecovery");
    }
  });

  it("accepts enum unmentioned group inbound values", () => {
    const legacy = validateConfigObjectRaw({
      messages: {
        groupChat: {
          unmentionedInbound: "user_request",
        },
      },
    });
    const roomEvent = validateConfigObjectRaw({
      messages: {
        groupChat: {
          unmentionedInbound: "room_event",
        },
      },
    });

    expect(legacy.ok).toBe(true);
    expect(roomEvent.ok).toBe(true);
    if (legacy.ok) {
      expect(legacy.config.messages?.groupChat?.unmentionedInbound).toBe("user_request");
    }
    if (roomEvent.ok) {
      expect(roomEvent.config.messages?.groupChat?.unmentionedInbound).toBe("room_event");
    }
  });

  it("rejects boolean unmentioned group inbound values", () => {
    const result = validateConfigObjectRaw({
      messages: {
        groupChat: {
          unmentionedInbound: true,
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find(
        (candidate) => candidate.path === "messages.groupChat.unmentionedInbound",
      );
      expect(issue?.path).toBe("messages.groupChat.unmentionedInbound");
    }
  });
});
