// Tests cover session transcript JSON parse guard behavior.
import { describe, expect, it } from "vitest";
import { parseAssistantTranscriptText, parseRecentConversationText } from "./transcript.js";

describe("parseAssistantTranscriptText", () => {
  it("returns undefined on malformed JSON", () => {
    expect(parseAssistantTranscriptText("NOT JSON {{{")).toBeUndefined();
  });

  it("returns undefined on empty string", () => {
    expect(parseAssistantTranscriptText("")).toBeUndefined();
  });

  it("returns undefined for non-assistant role", () => {
    const line = JSON.stringify({
      id: "msg-1",
      message: { role: "user", content: "hello" },
    });
    expect(parseAssistantTranscriptText(line)).toBeUndefined();
  });

  it("parses a valid assistant transcript line", () => {
    const line = JSON.stringify({
      id: "msg-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
      },
    });
    const result = parseAssistantTranscriptText(line);
    expect(result).toBeDefined();
    expect(result?.id).toBe("msg-1");
  });
});

describe("parseRecentConversationText", () => {
  it("returns undefined on malformed JSON", () => {
    expect(parseRecentConversationText("NOT JSON {{{")).toBeUndefined();
  });

  it("returns undefined on empty string", () => {
    expect(parseRecentConversationText("")).toBeUndefined();
  });

  it("returns undefined for non-user/non-assistant role", () => {
    const line = JSON.stringify({
      id: "msg-1",
      message: { role: "system", content: "system prompt" },
    });
    expect(parseRecentConversationText(line)).toBeUndefined();
  });

  it("parses a valid user conversation line", () => {
    const line = JSON.stringify({
      id: "msg-2",
      message: {
        role: "user",
        content: [{ type: "text", text: "hi" }],
      },
    });
    const result = parseRecentConversationText(line);
    expect(result).toBeDefined();
    expect(result?.id).toBe("msg-2");
  });
});
