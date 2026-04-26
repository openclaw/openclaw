import { describe, expect, it } from "vitest";
import { buildTranscriptReplyTextFromPayloads } from "./webchat-transcript-reply-text.js";

describe("buildTranscriptReplyTextFromPayloads", () => {
  it("omits reasoning payload text from transcript (regression: #71910)", () => {
    expect(
      buildTranscriptReplyTextFromPayloads([
        { text: "  Reasoning:\\n_foo_  ", isReasoning: true },
        { text: "Hello" },
      ]),
    ).toBe("Hello");
  });

  it("keeps non-reasoning and reply directives in order", () => {
    expect(
      buildTranscriptReplyTextFromPayloads([
        { text: "Visible", isReasoning: false },
        { text: "Also visible" },
      ]),
    ).toBe("Visible\n\nAlso visible");
  });

  it("returns empty when all payloads are reasoning-only", () => {
    expect(
      buildTranscriptReplyTextFromPayloads([{ text: "think", isReasoning: true }]),
    ).toBe("");
  });
});
