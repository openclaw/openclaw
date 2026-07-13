import { describe, expect, it } from "vitest";
import { buildChatSendBtwSideResult } from "./chat-send-nonagent-finalization.js";

describe("buildChatSendBtwSideResult", () => {
  it("combines BTW replies and preserves their error state", () => {
    expect(
      buildChatSendBtwSideResult([
        { kind: "block", payload: { text: "ignored" } },
        {
          kind: "final",
          payload: { text: "first", btw: { question: "  why?  " } },
        },
        {
          kind: "final",
          payload: { text: "second", btw: { question: "why?" }, isError: true },
        },
      ]),
    ).toEqual({
      question: "why?",
      text: "first\n\nsecond",
      isError: true,
    });
  });

  it("ignores empty or absent BTW replies", () => {
    expect(
      buildChatSendBtwSideResult([
        { kind: "final", payload: { text: "answer" } },
        { kind: "final", payload: { text: "  ", btw: { question: "why?" } } },
      ]),
    ).toBeUndefined();
  });
});
