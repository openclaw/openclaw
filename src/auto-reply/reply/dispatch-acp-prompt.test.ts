import { describe, expect, it } from "vitest";
import { resolveAcpTurnText } from "./dispatch-acp-prompt.js";

describe("ACP turn delivery guidance", () => {
  it.each([undefined, "automatic"] as const)("preserves the prompt for %s delivery", (mode) => {
    expect(resolveAcpTurnText({ promptText: "Answer this", sourceReplyDeliveryMode: mode })).toBe(
      "Answer this",
    );
  });

  it("explains tool-only delivery without assuming a tool, target, or omitted-final default", () => {
    const text = resolveAcpTurnText({
      promptText: "Answer this",
      sourceReplyDeliveryMode: "message_tool_only",
    });
    expect(text).toContain("not automatically sent");
    expect(text).toContain("Without that tool, you cannot send a reply here");
    expect(text).toContain("follow its target requirements");
    expect(text).toContain("final=false for chat updates and mid-task answers");
    expect(text).not.toMatch(/commentary|progress_card|or omit|default target/);
    expect(text.endsWith("\n\nAnswer this")).toBe(true);
  });
});
