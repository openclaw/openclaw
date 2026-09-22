import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";
import { redactTranscriptMessage } from "./transcript-redact.js";

describe("GitHub Copilot Responses reasoning replay (#155984)", () => {
  it("preserves a valid 416-character reasoning id and opaque ciphertext", () => {
    const id = "A".repeat(416);
    const encryptedContent = "Q".repeat(32) + "/LTAI" + "B".repeat(20) + "/" + "C".repeat(6);
    const signature = JSON.stringify({
      id,
      type: "reasoning",
      summary: [],
      encrypted_content: encryptedContent,
    });
    const message = castAgentMessage({
      role: "assistant",
      provider: "github-copilot",
      api: "openai-responses",
      model: "gpt-5.5",
      content: [{ type: "thinking", thinking: "", thinkingSignature: signature }],
    }) as AgentMessage;

    const redacted = redactTranscriptMessage(message);

    expect(redacted).toBe(message);
    expect(JSON.stringify(redacted)).toContain(signature);
    expect(JSON.stringify(redacted)).not.toContain("\u2026");
  });
});
