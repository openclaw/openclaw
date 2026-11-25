import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import { expect, it } from "vitest";
import {
  buildAgentMessageFromConversationEntries as buildPrompt,
  type ConversationEntry,
} from "./agent-prompt.js";

function message(
  role: ConversationEntry["role"],
  body: string,
  sender = role === "user" ? "User" : "Assistant",
) {
  return { role, entry: { sender, body } };
}
function text(...words: string[]) {
  return words.map((word) => ({ type: "text", text: word })) as unknown as string;
}
const history = (past: string, current: string) =>
  `[Chat messages since your last reply - for context]\n${past}\n\n[Current message - respond to this]\n${current}`;

it.each([
  ["empty conversation", [], ""],
  [
    "mixed content without history",
    [
      message("user", [
        { type: "text", text: "hi" },
        { type: "image", data: "base64-image", mimeType: "image/png" },
        { type: "text", text: "there" },
      ] as unknown as string),
    ],
    "hi there",
  ],
  [
    "last tool entry over assistant",
    [
      message("user", "question"),
      message("tool", "tool output", "Tool:x"),
      message("assistant", "assistant text"),
    ],
    history("User: question", "Tool:x: tool output"),
  ],
  [
    "content arrays in history and current message",
    [message("assistant", text("prev")), message("user", text("next", "step"))],
    history("Assistant: prev", "User: next step"),
  ],
  [
    "provenance-marked stream error omitted",
    [
      message("user", "first"),
      { ...message("assistant", text(STREAM_ERROR_FALLBACK_TEXT)), internalStreamError: true },
      message("user", "retry"),
    ],
    history("User: first", "User: retry"),
  ],
  [
    "unmarked stream error preserved",
    [message("assistant", STREAM_ERROR_FALLBACK_TEXT), message("user", "next")],
    history(`Assistant: ${STREAM_ERROR_FALLBACK_TEXT}`, "User: next"),
  ],
  [
    "empty tool output preserved",
    [message("user", "lookup"), message("tool", "", "Tool:call_1"), message("user", "continue")],
    history("User: lookup\nTool:call_1: ", "User: continue"),
  ],
] satisfies Array<[string, ConversationEntry[], string]>)(
  "builds gateway prompt: %s",
  (_name, entries, expected) => {
    expect(buildPrompt(entries)).toBe(expected);
  },
);
