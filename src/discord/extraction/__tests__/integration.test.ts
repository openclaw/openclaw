/**
 * Integration Helper Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  MAX_EXTRACTION_SIZE,
  detectLLMType,
  extractOrFallback,
  looksLikeRawPTYOutput,
  backupExtraction,
} from "../integration.js";

describe("Integration Helpers", () => {
  describe("MAX_EXTRACTION_SIZE", () => {
    it("should be set to 1MB", () => {
      expect(MAX_EXTRACTION_SIZE).toBe(1024 * 1024);
    });
  });

  describe("detectLLMType", () => {
    describe("from output markers", () => {
      it("should detect claude-code from ⏺ marker", () => {
        const output = "> command\n⏺ Response text";
        expect(detectLLMType(undefined, output)).toBe("claude-code");
      });

      it("should detect codex from • marker", () => {
        const output = "› command\n• Response text";
        expect(detectLLMType(undefined, output)).toBe("codex");
      });

      it("should prioritize output markers over command", () => {
        const output = "⏺ Response";
        const command = "codex";
        expect(detectLLMType(command, output)).toBe("claude-code");
      });
    });

    describe("from command string", () => {
      it("should detect claude-code from command", () => {
        expect(detectLLMType("claude code --help")).toBe("claude-code");
        expect(detectLLMType("moltbot chat")).toBe("claude-code");
      });

      it("should detect codex from command", () => {
        expect(detectLLMType("codex chat")).toBe("codex");
        expect(detectLLMType("aider --model gpt-4")).toBe("codex");
      });

      it("should be case-insensitive", () => {
        expect(detectLLMType("CLAUDE CODE")).toBe("claude-code");
        expect(detectLLMType("CODEX CHAT")).toBe("codex");
      });
    });

    describe("fallback to default", () => {
      it("should return default for unknown commands", () => {
        expect(detectLLMType("python script.py")).toBe("default");
        expect(detectLLMType("bash script.sh")).toBe("default");
      });

      it("should return default for no input", () => {
        expect(detectLLMType()).toBe("default");
      });
    });
  });

  describe("extractOrFallback", () => {
    describe("successful extraction", () => {
      it("should extract claude-code response", () => {
        const output = "> command\n⏺ Clean response\n● Feedback?";
        const result = extractOrFallback(output, "claude-code");

        expect(result.extracted).toBe(true);
        expect(result.text).toBe("Clean response");
        expect(result.metrics).toBeDefined();
      });

      it("should extract codex response", () => {
        const output = "› command\n• Clean response\n───────";
        const result = extractOrFallback(output, "codex");

        expect(result.extracted).toBe(true);
        expect(result.text).toBe("Clean response");
      });

      it("should auto-detect LLM type from output", () => {
        const output = "⏺ Clean response";
        const result = extractOrFallback(output);

        expect(result.extracted).toBe(true);
        expect(result.text).toBe("Clean response");
      });
    });

    describe("fallback to raw output", () => {
      it("should fallback when no marker found", () => {
        const output = "No marker here";
        const result = extractOrFallback(output);

        expect(result.extracted).toBe(false);
        expect(result.text).toBe(output);
        expect(result.error).toContain("No response marker found");
      });

      it("should fallback when extraction fails", () => {
        const output = "Some output without markers";
        const result = extractOrFallback(output, "default");

        expect(result.extracted).toBe(false);
        expect(result.text).toBe(output);
      });

      it("should respect fallbackToRaw option", () => {
        const output = "No marker";
        const result = extractOrFallback(output, undefined, {
          fallbackToRaw: false,
        });

        expect(result.extracted).toBe(false);
        expect(result.text).toBe("");
        expect(result.error).toBeDefined();
      });
    });

    describe("size limits", () => {
      it("should skip extraction for large output", () => {
        const largeOutput = "x".repeat(MAX_EXTRACTION_SIZE + 1);
        const result = extractOrFallback(largeOutput);

        expect(result.extracted).toBe(false);
        expect(result.text).toBe(largeOutput);
        expect(result.error).toContain("too large");
      });

      it("should extract if under size limit", () => {
        const output = "⏺ Response";
        expect(output.length).toBeLessThan(MAX_EXTRACTION_SIZE);

        const result = extractOrFallback(output);
        expect(result.extracted).toBe(true);
      });
    });

    describe("with command option", () => {
      it("should use command for detection if no LLM type", () => {
        const output = "⏺ Response";
        const result = extractOrFallback(output, undefined, {
          command: "claude code chat",
        });

        expect(result.extracted).toBe(true);
      });
    });
  });

  describe("looksLikeRawPTYOutput", () => {
    it("should detect claude-code marker", () => {
      expect(looksLikeRawPTYOutput("⏺ Response")).toBe(true);
    });

    it("should detect codex marker", () => {
      expect(looksLikeRawPTYOutput("• Response")).toBe(true);
    });

    it("should detect feedback prompt", () => {
      expect(looksLikeRawPTYOutput("● How did that go?")).toBe(true);
    });

    it("should detect separators", () => {
      expect(looksLikeRawPTYOutput("───────────")).toBe(true);
      expect(looksLikeRawPTYOutput("═══════════")).toBe(true);
    });

    it("should detect common prompts", () => {
      expect(looksLikeRawPTYOutput("> command")).toBe(true);
      expect(looksLikeRawPTYOutput("$ ls")).toBe(true);
    });

    it("should return false for clean text", () => {
      expect(looksLikeRawPTYOutput("Just a clean response")).toBe(false);
      expect(looksLikeRawPTYOutput("Multi-line\nclean\nresponse")).toBe(false);
    });
  });

  describe("backupExtraction", () => {
    describe("skipping conditions", () => {
      it("should skip if already extracted", () => {
        const text = "⏺ Response";
        const result = backupExtraction(text, { wasExtracted: true });

        expect(result.extracted).toBe(false);
        expect(result.wasBackup).toBe(false);
        expect(result.text).toBe(text);
      });

      it("should skip if does not look like PTY output", () => {
        const text = "Clean response text";
        const result = backupExtraction(text);

        expect(result.extracted).toBe(false);
        expect(result.wasBackup).toBe(false);
        expect(result.text).toBe(text);
      });
    });

    describe("successful backup extraction", () => {
      it("should extract from raw PTY output", () => {
        const text = "> command\n⏺ Clean response\n● Feedback?";
        const result = backupExtraction(text);

        expect(result.extracted).toBe(true);
        expect(result.wasBackup).toBe(true);
        expect(result.text).toBe("Clean response");
      });

      it("should use command metadata for detection", () => {
        const text = "⏺ Response";
        const result = backupExtraction(text, {
          command: "claude code chat",
        });

        expect(result.extracted).toBe(true);
        expect(result.wasBackup).toBe(true);
      });
    });

    describe("failed backup extraction", () => {
      it("should fallback to original text on extraction failure", () => {
        // Text with PTY indicator but no actual response marker
        const text = '$ echo "test"\ntest output here';
        const result = backupExtraction(text);

        // Will attempt extraction (has $ prompt) but find no response
        expect(result.wasBackup).toBe(true);
        expect(result.text).toBe(text); // Falls back to original
      });
    });
  });

  describe("integration scenarios", () => {
    it("should handle agent-side extraction flow", () => {
      // Agent retrieves PTY output
      const ptyOutput = "> echo hello\n⏺ HEALTH_123\n\nGot it!";

      // Agent calls extraction
      const result = extractOrFallback(ptyOutput, "claude-code");

      expect(result.extracted).toBe(true);
      expect(result.text).toContain("Got it!");
      expect(result.text).not.toContain("HEALTH_");
    });

    it("should handle backup extraction flow", () => {
      // Agent forgot to extract
      const rawOutput = "⏺ This is the response\n● Feedback?";

      // Infrastructure-level backup
      const result = backupExtraction(rawOutput);

      expect(result.extracted).toBe(true);
      expect(result.wasBackup).toBe(true);
      expect(result.text).toBe("This is the response");
    });

    it("should handle size limit protection", () => {
      // Agent spawns process with huge output
      const hugeOutput = "⏺ " + "x".repeat(MAX_EXTRACTION_SIZE);

      // Extraction skipped for performance
      const result = extractOrFallback(hugeOutput);

      expect(result.extracted).toBe(false);
      expect(result.error).toContain("too large");
      expect(result.text).toBe(hugeOutput); // Fallback to raw
    });
  });
});
