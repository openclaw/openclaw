import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import { extractText } from "../../ui/src/lib/chat/message-extract.ts";
import { buildChatMarkdown } from "../../ui/src/pages/chat/export.ts";

export const spoken =
  "SPOKEN_133855: Keep the literal labels Context: and Spoken style: in my note.";
export const answer = "ANSWER_133855: Both labels are preserved.";
export const consultAnswer = "INTERNAL_FINAL_133855: The note contains both requested labels.";
export const consultCommentary = "COMMENTARY_133855: Checking the saved note.";
export const consultToolResult = "TOOL_RESULT_133855: Context: and Spoken style: are present.";
export const args = {
  question: "GENERATED_QUESTION_133855: Check the note requested by the speaker.",
  context: "GENERATED_CONTEXT_133855: The call already has a finalized human transcript.",
  responseStyle: "GENERATED_STYLE_133855: Speak one short sentence.",
};
export const syntheticMarkers = Object.values(args);

export function expectNoGeneratedInput(messages: unknown[], surface: string) {
  const markdown = buildChatMarkdown(messages, "Voice test assistant");
  const serialized = JSON.stringify(messages);
  expect
    .soft(
      syntheticMarkers.filter((marker) => serialized.includes(marker)),
      surface,
    )
    .toEqual([]);
  expect
    .soft(
      syntheticMarkers.filter((marker) => markdown?.includes(marker)),
      `${surface} Markdown`,
    )
    .toEqual([]);
}
export function expectVisibleSpeechOnly(messages: unknown[], surface: string, hasAnswer: boolean) {
  const users = messages.filter((message) => asOptionalRecord(message)?.role === "user");
  expect.soft(users.map(extractText), surface).toEqual([spoken]);
  const markdown = buildChatMarkdown(messages, "Voice test assistant");
  expect.soft(markdown, `${surface} Markdown`).toContain(spoken);
  expect
    .soft(markdown?.match(/^## Message(?: \(|$)/gm), `${surface} input headings`)
    .toHaveLength(1);
  expectNoGeneratedInput(messages, surface);
  expect
    .soft(
      messages.map(extractText).filter((text) => text === answer),
      `${surface} spoken answer`,
    )
    .toHaveLength(hasAnswer ? 1 : 0);
  expect
    .soft(markdown?.split(answer).length, `${surface} spoken answer in Markdown`)
    .toBe(hasAnswer ? 2 : 1);
  expect.soft(JSON.stringify(messages), `${surface} internal final`).not.toContain(consultAnswer);
  expect.soft(markdown, `${surface} internal final in Markdown`).not.toContain(consultAnswer);
}
