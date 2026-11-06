// @vitest-environment node
// Control UI tests cover message extract behavior.
import { describe, expect, it } from "vitest";
import { extractText, extractTextCached, extractThinkingCached } from "./message-extract.ts";

describe("extractTextCached", () => {
  it("returns consistent text output for repeated calls", () => {
    const message = {
      role: "user",
      content: "plain text",
    };
    expect(extractTextCached(message)).toBe("plain text");
    expect(extractTextCached(message)).toBe("plain text");
  });
});

describe("nullish messages", () => {
  // Chat events can arrive without a message (tool-only or heartbeat finals);
  // every unknown-typed extractor must read that as "no text", not throw.
  it("returns null instead of throwing for absent messages", () => {
    for (const message of [undefined, null]) {
      expect(extractText(message)).toBeNull();
      expect(extractTextCached(message)).toBeNull();
      expect(extractThinkingCached(message)).toBeNull();
    }
  });

  it.each(["user", "assistant", "toolResult"])(
    "preserves %s text and thinking around malformed content blocks",
    (role) => {
      const message = {
        role,
        content: [
          null,
          { type: "text", text: "Visible reply" },
          undefined,
          { type: "thinking", thinking: "Plan A" },
          [],
        ],
      };
      expect(extractText(message)).toBe("Visible reply");
      expect(extractTextCached(message)).toBe("Visible reply");
      expect(extractThinkingCached(message)).toBe("Plan A");
      expect(extractText({ role, content: [null], text: "Fallback text" })).toBe("Fallback text");
      expect(extractText({ role, content: [null] })).toBeNull();
    },
  );
});
