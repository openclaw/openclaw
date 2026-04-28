import { describe, expect, it } from "vitest";
import { isLikelyConversationalFreeformBody } from "./get-reply-directives.js";
import { CURRENT_MESSAGE_MARKER } from "./mentions.js";

describe("isLikelyConversationalFreeformBody", () => {
  it.each(["/status", "/review src/foo.ts", "  /reset soft"])(
    "rejects slash command bodies: %s",
    (body) => {
      expect(isLikelyConversationalFreeformBody(body)).toBe(false);
    },
  );

  it("rejects rewritten skill prompt scaffolds", () => {
    expect(
      isLikelyConversationalFreeformBody(
        'Use the "review-orchestra" skill for this request.\n\nUser input:\nPR #1',
      ),
    ).toBe(false);
  });

  it("rejects current-message channel envelopes around command bodies", () => {
    expect(
      isLikelyConversationalFreeformBody(
        `${CURRENT_MESSAGE_MARKER}\n[WhatsApp +15555550123] Bob: /status\n[from: Bob]`,
      ),
    ).toBe(false);
  });

  it.each(["これちょっと見てくれる？", "Can you take a quick look?"])(
    "accepts short natural-language messages: %s",
    (body) => {
      expect(isLikelyConversationalFreeformBody(body)).toBe(true);
    },
  );

  it.each([
    "# Plan\n- item one\n- item two",
    "- item one\n- item two",
    "1. item one\n2. item two",
    "```ts\nconsole.log('hi');\n```",
  ])("rejects markdown/list-shaped bodies", (body) => {
    expect(isLikelyConversationalFreeformBody(body)).toBe(false);
  });

  it.each([
    "Task: fix PR #1",
    "User input:\nPR #1",
    "[Subagent Context] You are running as a subagent (depth 1/1).",
  ])("rejects obvious task scaffolding", (body) => {
    expect(isLikelyConversationalFreeformBody(body)).toBe(false);
  });
});
