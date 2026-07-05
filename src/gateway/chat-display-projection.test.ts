import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
  sanitizeChatHistoryMessages,
} from "./chat-display-projection.js";

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= text.length) {
        return true;
      }
      const next = text.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      i++;
    }
  }
  return false;
}

describe("chat-display-projection UTF-16 safe truncation", () => {
  it("does not split surrogate pairs when truncating message content strings", () => {
    // 19 "a" + "😀" + "tail" = 25 chars. The emoji at positions 19-20
    // crosses the 20-char truncation boundary.
    // Old raw slice(0, 20) would keep the lone high surrogate at position 19;
    // truncateUtf16Safe backs off to 19.
    const messageContent = `${"a".repeat(19)}😀tail`;

    const result = sanitizeChatHistoryMessages(
      [{ role: "user", content: messageContent }],
      20,
    ) as Array<Record<string, unknown>>;

    const text = result[0]?.content as string;
    expect(hasLoneSurrogate(text)).toBe(false);
    expect(text).toContain("...(truncated)...");
  });

  it("does not split surrogate pairs when truncating content block text", () => {
    const messageText = `${"a".repeat(19)}😀tail`;

    const result = sanitizeChatHistoryMessages(
      [{ role: "assistant", content: [{ type: "text", text: messageText }] }],
      20,
    ) as Array<Record<string, unknown>>;

    const blocks = result[0]?.content as Array<{ text?: string }>;
    const text = blocks?.[0]?.text ?? "";
    expect(hasLoneSurrogate(text)).toBe(false);
    expect(text).toContain("...(truncated)...");
  });

  it("uses configured maxChars instead of the default 8k cap", () => {
    // Messages within the override cap should not be truncated.
    const shortText = "hello world";
    const result = sanitizeChatHistoryMessages(
      [{ role: "user", content: shortText }],
      DEFAULT_CHAT_HISTORY_TEXT_MAX_CHARS,
    ) as Array<Record<string, unknown>>;

    expect(result[0]?.content).toBe(shortText);
  });
});
