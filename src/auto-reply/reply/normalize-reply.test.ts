import { describe, it, expect } from "vitest";
import { normalizeReplyPayload } from "./normalize-reply.js";

const CONV_BLOCK = `Conversation info (untrusted metadata):
\`\`\`json
{
  "message_id": "msg-abc",
  "chat_id": "12345",
  "channel": "discord"
}
\`\`\``;

const SENDER_BLOCK = `Sender (untrusted metadata):
\`\`\`json
{
  "label": "Alice",
  "name": "Alice"
}
\`\`\``;

describe("normalizeReplyPayload", () => {
  it("strips echoed Conversation info metadata from model output", () => {
    const result = normalizeReplyPayload({
      text: `${CONV_BLOCK}\n\nHere is your answer!`,
    });
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Here is your answer!");
  });

  it("strips multiple echoed metadata blocks from model output", () => {
    const result = normalizeReplyPayload({
      text: `${CONV_BLOCK}\n\n${SENDER_BLOCK}\n\nHere is your answer!`,
    });
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Here is your answer!");
  });

  it("passes through normal text without metadata unchanged", () => {
    const result = normalizeReplyPayload({ text: "Hello, world!" });
    expect(result).not.toBeNull();
    expect(result!.text).toBe("Hello, world!");
  });

  it("returns null for empty text with no media", () => {
    expect(normalizeReplyPayload({ text: "" })).toBeNull();
  });

  it("returns null when model output is only metadata (no actual content)", () => {
    expect(normalizeReplyPayload({ text: CONV_BLOCK })).toBeNull();
  });

  it("returns null when model output is only multiple metadata blocks", () => {
    expect(normalizeReplyPayload({ text: `${CONV_BLOCK}\n\n${SENDER_BLOCK}` })).toBeNull();
  });

  it("does not strip sentinel text that lacks a fenced JSON block", () => {
    const text = 'The "Conversation info (untrusted metadata):" header is used for context.';
    const result = normalizeReplyPayload({ text });
    expect(result).not.toBeNull();
    expect(result!.text).toContain("Conversation info");
  });
});
