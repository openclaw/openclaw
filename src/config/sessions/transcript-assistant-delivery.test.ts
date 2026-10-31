import { expect, it } from "vitest";
import { isSilentAssistantTranscriptMessage } from "../../shared/chat-message-content.js";
import { applyAssistantDeliveryDirectives } from "./transcript-assistant-delivery.js";

const textPart = (text: string, textSignature: string) => ({ type: "text", text, textSignature });
const part = (text: string, phase: string, id?: string) =>
  textPart(text, JSON.stringify({ v: 1, ...(id ? { id } : {}), phase }));
function expectIdempotent(message: Parameters<typeof applyAssistantDeliveryDirectives>[0]) {
  const snapshot = structuredClone(message);
  expect(applyAssistantDeliveryDirectives(message)).toEqual(snapshot);
}

it.each([
  {
    parts: ["Prefix.", "[[reply_to:`quoted`]]Reply."],
    expected: ["Prefix.", "Reply."],
    facts: { replyToId: "`quoted`" },
  },
  {
    parts: ["Prefix.", "Shown. [[tts:text]]Speak `code` \uE0000\uE000.[[/tts:text]]"],
    expected: ["Prefix.", "Shown."],
    facts: { tts: { tagged: true, text: "Speak `code` \uE0000\uE000." } },
  },
  {
    parts: ["Prefix.", "[[tts:provider=openai voice=`quoted`]]Shown."],
    expected: ["Prefix.", "Shown."],
    facts: {
      tts: { tagged: true, directives: [{ provider: "openai", values: { voice: "`quoted`" } }] },
    },
  },
  {
    parts: ["Use `", "  [[reply_to:literal]]  `\n[[audio_as_voice]]Done."],
    expected: ["Use `", "  [[reply_to:literal]]  `\nDone."],
    facts: { audioAsVoice: true },
  },
  {
    parts: ["[[tts:text]]Spoken only.[[/tts:text]]NO_REPLY"],
    expected: ["NO_REPLY"],
    facts: { tts: { tagged: true, text: "Spoken only." } },
  },
])("normalizes $parts idempotently", ({ parts, expected, facts }) => {
  const content = parts.map((text, index) => textPart(text, `native-${index}`));
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
  expectIdempotent(message);
});

it.each([
  { parts: ["[[audio_as_voice]]", "NO_REPLY"], display: true, hidden: false },
  { parts: ["NO_", "REPLY\n[[audio_as_voice]]NO_REPLY"], display: undefined, hidden: false },
  { parts: ["NO_REPLY"], display: undefined, hidden: true },
  { parts: ["no_", "reply\n[[audio_as_voice]]No_Reply"], display: undefined, hidden: false },
  { parts: ["No_Reply"], display: undefined, hidden: true },
  {
    parts: ["[[audio_as_voice]]NO_REPLY"],
    inputDisplay: false,
    display: false,
    hidden: true,
    unsigned: true,
  },
])("preserves visibility of $parts", ({ parts, inputDisplay, display, hidden, unsigned }) => {
  const message = {
    role: "assistant",
    ...(inputDisplay === undefined ? {} : { display: inputDisplay }),
    content: parts.map((text) => (unsigned ? { type: "text", text } : part(text, "final_answer"))),
  };
  const prepared = applyAssistantDeliveryDirectives(message);
  expect("display" in prepared ? prepared.display : undefined).toBe(display);
  expect(isSilentAssistantTranscriptMessage(prepared)).toBe(hidden);
  expectIdempotent(prepared);
});

it("keeps commentary code context separate from final intent", () => {
  const message = {
    role: "assistant",
    content: [
      part("```text\n[[reply_to:commentary]]", "commentary", "progress"),
      part("[[reply_to_current]]Final reply.", "final_answer", "answer"),
    ],
  };
  applyAssistantDeliveryDirectives(message);
  expect(message).toMatchObject({
    display: true,
    content: [{ text: "```text\n[[reply_to:commentary]]" }, { text: "Final reply." }],
    openclawDelivery: { replyToCurrent: true },
  });
});
