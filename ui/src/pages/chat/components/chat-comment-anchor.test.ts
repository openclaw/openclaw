import { afterEach, describe, expect, it } from "vitest";
import { resolveChatCommentAnchor } from "./chat-comment-anchor.ts";

afterEach(() => {
  document.body.replaceChildren();
});

function sourceBubbles() {
  const root = document.createElement("div");
  root.innerHTML =
    '<div class="chat-bubble" data-entry-id="entry-1" data-message-id="message-1">Before <p>Repeat 🦞 <strong>repeat</strong><br>last</p></div><div class="chat-bubble" data-entry-id="entry-2" data-message-id="message-2">repeat</div>';
  document.body.append(root);
  return Array.from(root.querySelectorAll<HTMLElement>(".chat-bubble"));
}

describe("saved comment source anchors", () => {
  it("resolves the exact repeated selection across formatted text and Unicode offsets", () => {
    const bubbles = sourceBubbles();
    const text = bubbles[0]!.textContent!;
    const start = text.indexOf("repeat");
    const result = resolveChatCommentAnchor(bubbles, {
      entryId: "entry-1",
      messageId: "message-1",
      start,
      end: text.length,
      text: "repeat\nlast",
    });
    expect(result?.range.toString()).toBe("repeatlast");
    expect(result?.bubble.dataset.entryId).toBe("entry-1");
    expect(bubbles[0]!.textContent).toBe(text);
  });

  it("does not attach a removed entry to a different message with the same text", () => {
    const bubbles = sourceBubbles();
    expect(
      resolveChatCommentAnchor(bubbles, {
        entryId: "missing",
        messageId: "message-2",
        start: 0,
        end: 6,
        text: "repeat",
      }),
    ).toBeNull();
  });

  it("uses the message identity before an entry identity is available", () => {
    const bubbles = sourceBubbles();
    expect(
      resolveChatCommentAnchor(bubbles, {
        messageId: "message-2",
        start: 0,
        end: 6,
        text: "repeat",
      })?.range.toString(),
    ).toBe("repeat");
  });

  it.each([
    { start: 0, end: 6, text: "changed" },
    { start: 0, end: 999, text: "repeat" },
  ])("rejects stale or unavailable offsets: %j", (source) => {
    expect(
      resolveChatCommentAnchor(sourceBubbles(), { messageId: "message-2", ...source }),
    ).toBeNull();
  });
});
