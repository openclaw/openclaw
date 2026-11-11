import { describe, expect, it } from "vitest";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";
import { sanitizeTranscriptMessage } from "./transcript-sanitize.js";

describe("Responses reasoning transcript preservation", () => {
  it.each([
    ["github-copilot", "openclaw-openai-responses-transport"],
    ["openai", "openai-responses"],
  ])("preserves opaque reasoning for %s / %s with 1024-character ids", (provider, api) => {
    const id = "A".repeat(1024);
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

    const redacted = sanitizeTranscriptMessage(message);

    expect(redacted).toMatchObject({
      content: [{ thinkingSignature: signature }],
    });
    expect(JSON.stringify(redacted)).not.toContain("\u2026");
  });
});
