import { describe, expect, it } from "vitest";
import { applyAssistantDeliveryDirectives } from "./transcript-assistant-delivery.js";

describe("assistant delivery normalization across native parts", () => {
  it.each([
    {
      name: "reply IDs containing code bytes",
      parts: ["Prefix.", "[[reply_to:`quoted`]]Reply."],
      expected: ["Prefix.", "Reply."],
      facts: { replyToId: "`quoted`" },
    },
    {
      name: "speech text containing code and placeholder-like bytes",
      parts: ["Prefix.", "Shown. [[tts:text]]Speak `code` \uE0000\uE000.[[/tts:text]]"],
      expected: ["Prefix.", "Shown."],
      facts: { tts: { tagged: true, text: "Speak `code` \uE0000\uE000." } },
    },
    {
      name: "speech directive values containing code bytes",
      parts: ["Prefix.", "[[tts:provider=openai voice=`quoted`]]Shown."],
      expected: ["Prefix.", "Shown."],
      facts: {
        tts: { tagged: true, directives: [{ provider: "openai", values: { voice: "`quoted`" } }] },
      },
    },
    {
      name: "code whitespace around a genuine voice directive",
      parts: ["Use `", "  [[reply_to:literal]]  `\n[[audio_as_voice]]Done."],
      expected: ["Use `", "  [[reply_to:literal]]  `\nDone."],
      facts: { audioAsVoice: true },
    },
  ])("preserves $name and remains idempotent", ({ parts, expected, facts }) => {
    const content = parts.map((text, index) => ({
      type: "text",
      text,
      textSignature: `native-${index}`,
    }));
    const identities = [...content];
    const message = { role: "assistant", content, openclawDelivery: { mediaUrls: ["./kept.png"] } };
    applyAssistantDeliveryDirectives(message);
    expect(message.content).toBe(content);
    expect(message.content.map((block) => block.text)).toEqual(expected);
    expect(message.openclawDelivery).toEqual({ mediaUrls: ["./kept.png"], ...facts });
    for (const [index, block] of message.content.entries()) {
      expect(block).toBe(identities[index]);
      expect(block.textSignature).toBe(`native-${index}`);
    }
    const prepared = structuredClone(message);
    applyAssistantDeliveryDirectives(message);
    expect(message).toEqual(prepared);
  });

  it("keeps commentary code context separate from final intent", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "```text\n[[reply_to:commentary]]",
          textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }),
        },
        {
          type: "text",
          text: "[[reply_to_current]]Final reply.",
          textSignature: JSON.stringify({ v: 1, id: "answer", phase: "final_answer" }),
        },
      ],
    };
    applyAssistantDeliveryDirectives(message);
    expect(message).toMatchObject({
      content: [{ text: "```text\n[[reply_to:commentary]]" }, { text: "Final reply." }],
      openclawDelivery: { replyToCurrent: true },
    });
  });
});
