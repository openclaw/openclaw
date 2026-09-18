// Verifies corrupt (mask-damaged) thinking signatures are dropped before replay.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import {
  isReplayableThinkingSignature,
  stripUnreplayableThinkingSignatures,
} from "./thinking-signatures.js";
import { castAgentMessages } from "./test-helpers/agent-message-fixtures.js";

const VALID_SIGNATURE = `ErUBCkYIBxgCKkC${"Ab9Xz-_".repeat(20)}EgyQ7w==`;
// Secret redaction masks a "-"-delimited 40-char base64 run as an AWS secret key
// and rewrites it as `<6 chars>…<4 chars>`, splicing U+2026 into the token.
const MASK_DAMAGED_SIGNATURE = `ErUBCkYIBxgCKkCAb9Xz-AbCdEf…WxYz-_EgyQ7w==`;

describe("isReplayableThinkingSignature", () => {
  it("accepts an opaque base64url provider token", () => {
    expect(isReplayableThinkingSignature(VALID_SIGNATURE)).toBe(true);
  });

  it("rejects a signature carrying the redaction mask marker", () => {
    expect(isReplayableThinkingSignature(MASK_DAMAGED_SIGNATURE)).toBe(false);
  });

  it("rejects empty, blank and non-string values", () => {
    expect(isReplayableThinkingSignature("")).toBe(false);
    expect(isReplayableThinkingSignature("  ")).toBe(false);
    expect(isReplayableThinkingSignature(undefined)).toBe(false);
  });
});

describe("stripUnreplayableThinkingSignatures", () => {
  it("drops a corrupt signature but keeps the thinking text", () => {
    const messages = castAgentMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning", thinkingSignature: MASK_DAMAGED_SIGNATURE },
        ],
      },
    ]) as AgentMessage[];

    const [message] = stripUnreplayableThinkingSignatures(messages);
    const [block] = (message as { content: Record<string, unknown>[] }).content;
    expect(block.thinkingSignature).toBeUndefined();
    expect(block.thinking).toBe("reasoning");
  });

  it("leaves a valid signature untouched and returns the original array", () => {
    const messages = castAgentMessages([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "ok", thinkingSignature: VALID_SIGNATURE }],
      },
    ]) as AgentMessage[];

    expect(stripUnreplayableThinkingSignatures(messages)).toBe(messages);
  });
});
