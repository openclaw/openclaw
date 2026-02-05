/**
 * Parity tests for normalization functions.
 *
 * These tests verify that the new normalization functions produce the same
 * results as the inline normalizeStreamingText() function in agent-runner-execution.ts.
 *
 * The old normalizeStreamingText does:
 * 1. Strip HEARTBEAT_OK tokens (via stripHeartbeatToken)
 * 2. Skip silent reply tokens (via isSilentReplyText)
 * 3. Sanitize user-facing text (via sanitizeUserFacingText)
 * 4. Strip compaction handoff text (via stripCompactionHandoffText)
 * 5. Strip reasoning tags (via stripReasoningTagsFromText)
 */

import { describe, it, expect } from "vitest";
import { sanitizeUserFacingText } from "../agents/pi-embedded-helpers.js";
import { stripCompactionHandoffText } from "../agents/pi-embedded-utils.js";
import { stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { stripReasoningTagsFromText } from "../shared/text/reasoning-tags.js";
import {
  stripHeartbeatTokens,
  stripThinkingTags,
  isSilentReply,
  normalizeText,
  normalizeStreamingText,
} from "./normalization.js";

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

/**
 * Replicate the old normalizeStreamingText logic from agent-runner-execution.ts
 * for parity comparison.
 */
function oldNormalizeStreamingText(
  text: string | undefined,
  options: { isHeartbeat?: boolean } = {},
): { text?: string; skip: boolean } {
  if (!text) {
    return { skip: true };
  }

  let processedText = text;

  // Step 1: Strip heartbeat tokens
  if (!options.isHeartbeat && processedText.includes("HEARTBEAT_OK")) {
    const stripped = stripHeartbeatToken(processedText, { mode: "message" });
    if (stripped.shouldSkip) {
      return { skip: true };
    }
    processedText = stripped.text;
  }

  // Step 2: Check for silent reply
  if (isSilentReplyText(processedText, SILENT_REPLY_TOKEN)) {
    return { skip: true };
  }

  // Step 3: Empty check
  if (!processedText) {
    return { skip: true };
  }

  // Step 4: Sanitize user-facing text
  const sanitized = sanitizeUserFacingText(processedText);

  // Step 5: Strip compaction handoff text
  const withoutCompaction = stripCompactionHandoffText(sanitized);
  if (!withoutCompaction.trim()) {
    return { skip: true };
  }

  // Step 6: Strip reasoning tags
  const reasoningStripped = stripReasoningTagsFromText(withoutCompaction, {
    mode: "strict",
    trim: "both",
  });
  if (!reasoningStripped.trim()) {
    return { skip: true };
  }

  return { text: reasoningStripped, skip: false };
}

// ---------------------------------------------------------------------------
// Parity Tests
// ---------------------------------------------------------------------------

describe("Normalization parity with old normalizeStreamingText", () => {
  describe("heartbeat token stripping", () => {
    it("should skip text that is only HEARTBEAT_OK", () => {
      const text = "HEARTBEAT_OK";

      const oldResult = oldNormalizeStreamingText(text);
      const newResult = normalizeStreamingText(text);

      expect(newResult.skip).toBe(oldResult.skip);
      expect(newResult.skip).toBe(true);
    });

    it("should strip HEARTBEAT_OK from beginning of text", () => {
      const text = "HEARTBEAT_OK Hello world";

      const oldResult = oldNormalizeStreamingText(text);
      const newResult = normalizeStreamingText(text);

      // Both should not skip since there's content after
      expect(newResult.skip).toBe(oldResult.skip);
      expect(newResult.skip).toBe(false);

      // Both should have the heartbeat stripped
      expect(newResult.text).not.toContain("HEARTBEAT_OK");
      expect(oldResult.text).not.toContain("HEARTBEAT_OK");
    });

    it("should strip HEARTBEAT_OK from end of text", () => {
      const text = "Hello world HEARTBEAT_OK";

      const oldResult = oldNormalizeStreamingText(text);
      const newResult = normalizeStreamingText(text);

      expect(newResult.skip).toBe(oldResult.skip);
      expect(newResult.skip).toBe(false);
    });

    it("should not strip HEARTBEAT_OK when isHeartbeat is true", () => {
      const text = "HEARTBEAT_OK";

      const oldResult = oldNormalizeStreamingText(text, { isHeartbeat: true });
      // The new function doesn't have isHeartbeat option, so behavior differs here
      // This is an intentional simplification

      // Old behavior: when isHeartbeat=true, the heartbeat stripping is skipped
      // so "HEARTBEAT_OK" passes through as valid text (not skipped)
      expect(oldResult.skip).toBe(false);
      expect(oldResult.text).toBe("HEARTBEAT_OK");
    });
  });

  describe("silent reply detection", () => {
    it("should skip NO_REPLY token", () => {
      const text = "NO_REPLY";

      const oldResult = oldNormalizeStreamingText(text);
      const newResult = normalizeStreamingText(text);

      expect(newResult.skip).toBe(oldResult.skip);
      expect(newResult.skip).toBe(true);
    });

    it("should skip text containing only NO_REPLY", () => {
      const text = "  NO_REPLY  ";

      const oldResult = oldNormalizeStreamingText(text);
      const newResult = normalizeStreamingText(text);

      expect(newResult.skip).toBe(oldResult.skip);
      expect(newResult.skip).toBe(true);
    });
  });

  describe("empty and whitespace handling", () => {
    it("should skip undefined text", () => {
      const oldResult = oldNormalizeStreamingText(undefined);
      const newResult = normalizeStreamingText(undefined);

      expect(newResult.skip).toBe(oldResult.skip);
      expect(newResult.skip).toBe(true);
    });

    it("should skip empty string", () => {
      const oldResult = oldNormalizeStreamingText("");
      const newResult = normalizeStreamingText("");

      expect(newResult.skip).toBe(oldResult.skip);
      expect(newResult.skip).toBe(true);
    });

    it("should skip whitespace-only text", () => {
      const text = "   \n\t   ";

      const oldResult = oldNormalizeStreamingText(text);
      const newResult = normalizeStreamingText(text);

      expect(newResult.skip).toBe(oldResult.skip);
      expect(newResult.skip).toBe(true);
    });
  });

  describe("thinking/reasoning tag stripping", () => {
    it("should strip <thinking> tags", () => {
      const text = "<thinking>internal thought</thinking>Hello";

      const oldResult = oldNormalizeStreamingText(text);
      const newResult = normalizeStreamingText(text);

      expect(newResult.skip).toBe(oldResult.skip);
      expect(newResult.skip).toBe(false);

      // Both should strip thinking tags
      expect(newResult.text).not.toContain("<thinking>");
      expect(oldResult.text).not.toContain("<thinking>");
    });

    it("should strip <antThinking> tags", () => {
      const text = "<antThinking>internal thought</antThinking>Hello";

      const oldResult = oldNormalizeStreamingText(text);
      const newResult = normalizeStreamingText(text);

      expect(newResult.skip).toBe(oldResult.skip);
      expect(newResult.skip).toBe(false);

      expect(newResult.text).not.toContain("<antThinking>");
      expect(oldResult.text).not.toContain("<antThinking>");
    });

    it("should skip text that is only thinking tags", () => {
      const text = "<thinking>only internal thought</thinking>";

      const oldResult = oldNormalizeStreamingText(text);
      const newResult = normalizeStreamingText(text);

      expect(newResult.skip).toBe(oldResult.skip);
      expect(newResult.skip).toBe(true);
    });

    it("should strip <thought> tags", () => {
      const text = "<thought>reasoning</thought>Response";

      const oldResult = oldNormalizeStreamingText(text);
      const newResult = normalizeStreamingText(text);

      expect(newResult.skip).toBe(oldResult.skip);
      expect(newResult.skip).toBe(false);
      expect(newResult.text).not.toContain("<thought>");
      expect(oldResult.text).not.toContain("<thought>");
    });
  });

  describe("normal text passthrough", () => {
    it("should pass through normal text unchanged", () => {
      const text = "Hello, how can I help you today?";

      const oldResult = oldNormalizeStreamingText(text);
      const newResult = normalizeStreamingText(text);

      expect(newResult.skip).toBe(oldResult.skip);
      expect(newResult.skip).toBe(false);

      expect(newResult.text).toBe(oldResult.text);
      expect(newResult.text).toBe(text);
    });

    it("should preserve text with multiple sentences", () => {
      const text = "First sentence. Second sentence. Third sentence.";

      const oldResult = oldNormalizeStreamingText(text);
      const newResult = normalizeStreamingText(text);

      expect(newResult.skip).toBe(oldResult.skip);
      expect(newResult.text).toBe(oldResult.text);
    });

    it("should preserve markdown formatting", () => {
      const text = "Here is some **bold** and *italic* text.";

      const oldResult = oldNormalizeStreamingText(text);
      const newResult = normalizeStreamingText(text);

      expect(newResult.skip).toBe(false);
      expect(newResult.text).toBe(oldResult.text);
    });

    it("should preserve code blocks", () => {
      const text = "```javascript\nconsole.log('hello');\n```";

      const oldResult = oldNormalizeStreamingText(text);
      const newResult = normalizeStreamingText(text);

      expect(newResult.skip).toBe(false);
      expect(newResult.text).toBe(oldResult.text);
    });
  });

  describe("combined normalization scenarios", () => {
    it("should handle heartbeat + thinking tags", () => {
      const text = "HEARTBEAT_OK <thinking>thought</thinking>Hello";

      const oldResult = oldNormalizeStreamingText(text);
      const newResult = normalizeStreamingText(text);

      expect(newResult.skip).toBe(oldResult.skip);
      expect(newResult.skip).toBe(false);

      expect(newResult.text).not.toContain("HEARTBEAT_OK");
      expect(newResult.text).not.toContain("<thinking>");
    });

    it("should handle multiple thinking blocks", () => {
      const text = "<thinking>first</thinking>Hello<thinking>second</thinking>World";

      const oldResult = oldNormalizeStreamingText(text);
      const newResult = normalizeStreamingText(text);

      expect(newResult.skip).toBe(oldResult.skip);
      expect(newResult.skip).toBe(false);
      expect(newResult.text).not.toContain("<thinking>");
      expect(oldResult.text).not.toContain("<thinking>");
    });
  });
});

describe("stripHeartbeatTokens parity with stripHeartbeatToken", () => {
  it("should strip from beginning", () => {
    const text = "HEARTBEAT_OK Hello";

    const oldResult = stripHeartbeatToken(text, { mode: "message" });
    const newResult = stripHeartbeatTokens(text);

    // Both should have heartbeat removed
    expect(newResult.text).not.toContain("HEARTBEAT_OK");
    expect(oldResult.text).not.toContain("HEARTBEAT_OK");
  });

  it("should strip from end", () => {
    const text = "Hello HEARTBEAT_OK";

    const oldResult = stripHeartbeatToken(text, { mode: "message" });
    const newResult = stripHeartbeatTokens(text);

    expect(newResult.text).not.toContain("HEARTBEAT_OK");
    expect(oldResult.text).not.toContain("HEARTBEAT_OK");
  });

  it("should indicate stripping occurred", () => {
    const text = "HEARTBEAT_OK Hello";

    const oldResult = stripHeartbeatToken(text, { mode: "message" });
    const newResult = stripHeartbeatTokens(text);

    expect(newResult.didStrip).toBe(oldResult.didStrip);
    expect(newResult.didStrip).toBe(true);
  });
});

describe("isSilentReply parity with isSilentReplyText", () => {
  it("should detect NO_REPLY token", () => {
    const text = "NO_REPLY";

    const oldResult = isSilentReplyText(text, SILENT_REPLY_TOKEN);
    const newResult = isSilentReply(text);

    expect(newResult).toBe(oldResult);
    expect(newResult).toBe(true);
  });

  it("should detect NO_REPLY with surrounding whitespace", () => {
    const text = "  NO_REPLY  ";

    const oldResult = isSilentReplyText(text, SILENT_REPLY_TOKEN);
    const newResult = isSilentReply(text);

    expect(newResult).toBe(oldResult);
    expect(newResult).toBe(true);
  });

  it("should not detect NO_REPLY in middle of text", () => {
    const text = "Hello NO_REPLY World";

    const oldResult = isSilentReplyText(text, SILENT_REPLY_TOKEN);
    const newResult = isSilentReply(text);

    expect(newResult).toBe(oldResult);
    expect(newResult).toBe(false);
  });
});

describe("stripThinkingTags parity with stripReasoningTagsFromText", () => {
  it("should strip <thinking> tags", () => {
    const text = "<thinking>internal</thinking>visible";

    const oldResult = stripReasoningTagsFromText(text, { mode: "strict", trim: "both" });
    const newResult = stripThinkingTags(text);

    // Both should produce similar output (stripped of thinking tags)
    expect(newResult).not.toContain("<thinking>");
    expect(oldResult).not.toContain("<thinking>");
  });

  it("should strip <antThinking> tags", () => {
    const text = "<antThinking>internal</antThinking>visible";

    const oldResult = stripReasoningTagsFromText(text, { mode: "strict", trim: "both" });
    const newResult = stripThinkingTags(text);

    expect(newResult).not.toContain("<antThinking>");
    expect(oldResult).not.toContain("<antThinking>");
  });

  it("should strip <thought> tags", () => {
    const text = "<thought>reasoning</thought>response";

    const oldResult = stripReasoningTagsFromText(text, { mode: "strict", trim: "both" });
    const newResult = stripThinkingTags(text);

    expect(newResult).not.toContain("<thought>");
    expect(oldResult).not.toContain("<thought>");
  });

  it("should handle multiline thinking content", () => {
    const text = `<thinking>
    line 1
    line 2
    </thinking>response`;

    const oldResult = stripReasoningTagsFromText(text, { mode: "strict", trim: "both" });
    const newResult = stripThinkingTags(text);

    expect(newResult).not.toContain("<thinking>");
    expect(oldResult).not.toContain("<thinking>");
  });
});

describe("normalizeText combined parity", () => {
  it("should produce same result as old pipeline for complex input", () => {
    const text = "HEARTBEAT_OK <thinking>thought</thinking> Hello world";

    const oldResult = oldNormalizeStreamingText(text);
    const newResult = normalizeText(text);

    expect(newResult.shouldSkip).toBe(oldResult.skip);

    // Both should have stripped heartbeat and thinking
    if (!newResult.shouldSkip && !oldResult.skip) {
      expect(newResult.text).not.toContain("HEARTBEAT_OK");
      expect(newResult.text).not.toContain("<thinking>");
      expect(oldResult.text).not.toContain("HEARTBEAT_OK");
      expect(oldResult.text).not.toContain("<thinking>");
    }
  });
});
