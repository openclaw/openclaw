import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { buildSkillRouteContext } from "./router-context.js";

describe("buildSkillRouteContext", () => {
  it("returns an empty recent message list when there is no recent text context", () => {
    expect(buildSkillRouteContext({ query: "  summarize this  " })).toStrictEqual({
      recentMessages: [],
    });
  });

  it("includes recent user and assistant text for short follow-up prompts", () => {
    const ctx = buildSkillRouteContext({
      query: "use that one",
      recentMessages: [
        message("user", "I need to update a Figma mockup."),
        message("assistant", "Use the design skill for this."),
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "large tool output" }],
          isError: false,
          timestamp: 3,
        },
      ],
    });

    expect(ctx.recentMessages).toStrictEqual([
      { role: "user", text: "I need to update a Figma mockup." },
      { role: "assistant", text: "Use the design skill for this." },
    ]);
  });

  it("keeps prior repeated short prompts as real routing context", () => {
    const ctx = buildSkillRouteContext({
      query: "same short prompt",
      recentMessages: [
        message("user", "Earlier context"),
        message("assistant", "Earlier answer"),
        message("user", "same short prompt"),
      ],
    });

    expect(ctx.recentMessages).toStrictEqual([
      { role: "user", text: "Earlier context" },
      { role: "assistant", text: "Earlier answer" },
      { role: "user", text: "same short prompt" },
    ]);
  });

  it("keeps only the latest six recent route context messages", () => {
    const longText = "x".repeat(2_000);
    const ctx = buildSkillRouteContext({
      query: "continue",
      recentMessages: [
        message("user", "oldest dropped"),
        message("user", longText),
        message("assistant", longText),
        message("user", longText),
        message("assistant", longText),
        message("user", longText),
        message("assistant", longText),
      ],
    });

    expect(ctx.recentMessages).toHaveLength(6);
    expect(ctx.recentMessages[0]?.text).toBe(longText);
    expect(
      ctx.recentMessages.some((recentMessage) => recentMessage.text === "oldest dropped"),
    ).toBe(false);
    expect(ctx.recentMessages.every((recentMessage) => recentMessage.text === longText)).toBe(true);
  });
});

function message(role: "user" | "assistant", content: string): AgentMessage {
  if (role === "user") {
    return { role, content, timestamp: 1 };
  }
  return {
    role,
    content: [{ type: "text", text: content }],
    api: "test",
    provider: "test",
    model: "test",
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}
