import { afterEach, describe, expect, it } from "vitest";
import { resolveChatCommentAnchor } from "./chat-comment-anchor.ts";

afterEach(() => {
  document.body.replaceChildren();
});

function sourceBubble() {
  const root = document.createElement("div");
  root.innerHTML =
    '<div class="chat-bubble" data-entry-id="entry-1" data-message-id="message-1">Before <p>Repeat 🦞 <strong>repeat</strong><br>last</p></div><div class="chat-bubble" data-entry-id="entry-2" data-message-id="message-2">repeat</div>';
  document.body.append(root);
  return root;
}

describe("saved comment source anchors", () => {
  it("resolves the exact repeated selection across formatted text and Unicode offsets", () => {
    const root = sourceBubble();
    const text = root.querySelector(".chat-bubble")!.textContent!;
    const start = text.indexOf("repeat");
    const result = resolveChatCommentAnchor(root, {
      entryId: "entry-1",
      messageId: "message-1",
      start,
      end: text.length,
      text: "repeat\nlast",
    });
    expect(result?.range.toString()).toBe("repeatlast");
    expect(result?.bubble.dataset.entryId).toBe("entry-1");
    expect(root.querySelector(".chat-bubble")!.textContent).toBe(text);
  });

  it("does not attach a removed entry to a different message with the same text", () => {
    const root = sourceBubble();
    expect(
      resolveChatCommentAnchor(root, {
        entryId: "missing",
        messageId: "message-2",
        start: 0,
        end: 6,
        text: "repeat",
      }),
    ).toBeNull();
  });

  it("uses the message identity before an entry identity is available", () => {
    const root = sourceBubble();
    expect(
      resolveChatCommentAnchor(root, {
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
      resolveChatCommentAnchor(sourceBubble(), { messageId: "message-2", ...source }),
    ).toBeNull();
  });
});
