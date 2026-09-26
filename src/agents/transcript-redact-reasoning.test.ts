import { describe, expect, it } from "vitest";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

describe("Responses reasoning transcript preservation", () => {
  it.each([
    ["github-copilot", "openai-responses", 416],
    ["github-copilot", "openclaw-openai-responses-transport", 1024],
    ["openai", "openai-responses", 1024],
  ])("preserves opaque reasoning for %s / %s with %i-character ids", (provider, api, length) => {
    const id = "A".repeat(length);
    const encryptedContent = "Q".repeat(32) + "/LTAI" + "B".repeat(20) + "/" + "C".repeat(6);
    const signature = JSON.stringify({
      id,
      type: "reasoning",
      summary: [],
      encrypted_content: encryptedContent,
    });
    const message = castAgentMessage({
      role: "assistant",
      provider,
      api,
      model: "gpt-5.5",
      content: [{ type: "thinking", thinking: "", thinkingSignature: signature }],
    });

    const redacted = redactTranscriptMessage(message);

    expect(redacted).toMatchObject({
      content: [{ thinkingSignature: signature }],
    });
    expect(JSON.stringify(redacted)).not.toContain("\u2026");
  });
});
