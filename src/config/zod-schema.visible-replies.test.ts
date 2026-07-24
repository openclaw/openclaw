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

  it("accepts operational reply delivery policies", () => {
    for (const policy of ["always", "once", "silent"] as const) {
      const result = validateConfigObjectRaw({
        messages: {
          operationalReplies: { policy },
        },
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.messages?.operationalReplies?.policy).toBe(policy);
      }
    }

    const redirect = validateConfigObjectRaw({
      messages: {
        operationalReplies: {
          policy: "redirect",
          redirectSessionKey: "agent:main:ops",
        },
      },
    });

    expect(redirect.ok).toBe(true);
    if (redirect.ok) {
      expect(redirect.config.messages?.operationalReplies).toEqual({
        policy: "redirect",
        redirectSessionKey: "agent:main:ops",
      });
    }
  });

  it("rejects operational reply redirect without a target session", () => {
    const result = validateConfigObjectRaw({
      messages: {
        operationalReplies: {
          policy: "redirect",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find(
        (candidate) => candidate.path === "messages.operationalReplies.redirectSessionKey",
      );
      expect(issue?.path).toBe("messages.operationalReplies.redirectSessionKey");
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
