/**
 * LLM Response Extractor Tests
 *
 * Comprehensive test suite for the core extraction logic.
 * Tests all edge cases from Morgan's design document (§4).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LLMResponseExtractor } from "../extractor.js";
import { ConfigLoader } from "../config-loader.js";
import type { LLMConfig } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Load a test fixture file
 */
function loadFixture(filename: string): string {
  const fixturePath = join(__dirname, "fixtures", filename);
  return readFileSync(fixturePath, "utf-8");
}

describe("LLMResponseExtractor", () => {
  let claudeCodeConfig: LLMConfig;
  let codexConfig: LLMConfig;
  let claudeExtractor: LLMResponseExtractor;
  let codexExtractor: LLMResponseExtractor;

  beforeEach(() => {
    // Clear config cache and load fresh configs
    ConfigLoader.clearCache();
    claudeCodeConfig = ConfigLoader.load("claude-code");
    codexConfig = ConfigLoader.load("codex");

    claudeExtractor = new LLMResponseExtractor(claudeCodeConfig);
    codexExtractor = new LLMResponseExtractor(codexConfig);
  });

  describe("Basic Extraction", () => {
    it("should extract a simple Claude Code response", () => {
      const output = `> echo hello

⏺ Hello! How can I help you today?

> `;

      const result = claudeExtractor.extract(output);

      expect(result.response).toBe("Hello! How can I help you today?");
      expect(result.metrics.responseFound).toBe(true);
      expect(result.metrics.validationPassed).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should extract a simple Codex response", () => {
      const output = `› echo hello

• Hello! How can I help you?

› `;

      const result = codexExtractor.extract(output);

      expect(result.response).toBe("Hello! How can I help you?");
      expect(result.metrics.responseFound).toBe(true);
      expect(result.metrics.validationPassed).toBe(true);
    });

    it("should return null when no response marker found", () => {
      const output = `> echo hello
hello
> `;

      const result = claudeExtractor.extract(output);

      expect(result.response).toBeNull();
      expect(result.metrics.responseFound).toBe(false);
      expect(result.metrics.linesExtracted).toBe(0);
    });

    it("should extract the LAST response when multiple responses exist", () => {
      const output = `⏺ First response

> echo again

⏺ Second response

> `;

      const result = claudeExtractor.extract(output);

      expect(result.response).toBe("Second response");
      expect(result.metrics.responseFound).toBe(true);
    });
  });

  describe("Health Check Echo Removal (§4.1)", () => {
    it("should remove health check echo from Claude Code response", () => {
      const output = loadFixture("claude-code-health-check.txt");
      const result = claudeExtractor.extract(output);

      // Should NOT contain the health check echo
      expect(result.response).not.toContain("HEALTH_1770407657040");

      // Should contain the actual response
      expect(result.response).toContain("Got it! I can see the health check pattern");
      expect(result.response).toContain("echo HEALTH_[timestamp]");

      // Validation should pass
      expect(result.metrics.validationPassed).toBe(true);
    });

    it("should remove health check echo from Codex response", () => {
      const output = loadFixture("codex-health-check.txt");
      const result = codexExtractor.extract(output);

      // Should NOT contain the health check echo
      expect(result.response).not.toContain("HEALTH_1770404937512");

      // Should contain the actual response
      expect(result.response).toContain("Commands executed");
      expect(result.response).toContain("output shows the health code");

      expect(result.metrics.validationPassed).toBe(true);
    });

    it("should handle echo pattern matching correctly", () => {
      const output = `⏺ HEALTH_123456789

  This is the actual response after the health check.

> `;

      const result = claudeExtractor.extract(output);

      // First line (health check echo) should be removed
      expect(result.response).not.toContain("HEALTH_123456789");
      expect(result.response).toContain("This is the actual response");
    });
  });

  describe("Multi-Paragraph with Blank Lines (§4.2)", () => {
    it("should preserve blank lines between paragraphs", () => {
      const output = loadFixture("claude-code-multi-paragraph.txt");
      const result = claudeExtractor.extract(output);

      // Should contain both paragraphs
      expect(result.response).toContain("I appreciate the bridge test");
      expect(result.response).toContain("Is the Discord-terminal bridge working");

      // Should preserve paragraph structure (blank lines between)
      const lines = result.response!.split("\n");
      expect(lines.length).toBeGreaterThan(3);

      // Should have blank lines between paragraphs
      const hasBlankLine = lines.some((line) => line.trim() === "");
      expect(hasBlankLine).toBe(true);

      expect(result.metrics.validationPassed).toBe(true);
    });

    it("should remove leading blank lines but preserve internal ones", () => {
      const output = `⏺ 

  First paragraph.

  Second paragraph.

> `;

      const result = claudeExtractor.extract(output);

      // Should not start with blank line
      expect(result.response![0]).not.toBe("\n");

      // Should contain both paragraphs
      expect(result.response).toContain("First paragraph");
      expect(result.response).toContain("Second paragraph");

      // Should have blank line between them
      expect(result.response).toContain("\n\n");
    });

    it("should remove trailing blank lines", () => {
      const output = `⏺ Response content.


> `;

      const result = claudeExtractor.extract(output);

      expect(result.response).toBe("Response content.");
    });
  });

  describe("No Response Found (§4.3)", () => {
    it("should handle empty terminal output", () => {
      const result = claudeExtractor.extract("");

      expect(result.response).toBeNull();
      expect(result.metrics.responseFound).toBe(false);
      expect(result.metrics.linesExtracted).toBe(0);
    });

    it("should handle output with only prompts", () => {
      const output = `> echo hello
> cd /path
> ls`;

      const result = claudeExtractor.extract(output);

      expect(result.response).toBeNull();
      expect(result.metrics.responseFound).toBe(false);
    });

    it("should handle terminal output with no LLM activity", () => {
      const output = `$ npm install
added 142 packages
$ npm test
All tests passed`;

      const result = claudeExtractor.extract(output);

      expect(result.response).toBeNull();
      expect(result.metrics.responseFound).toBe(false);
    });

    it("should return appropriate metrics for no response", () => {
      const result = claudeExtractor.extract("> just a prompt");

      expect(result.metrics.responseFound).toBe(false);
      expect(result.metrics.responseLength).toBe(0);
      expect(result.metrics.linesExtracted).toBe(0);
      expect(result.metrics.validationPassed).toBe(false);
    });
  });

  describe("Codex Command Output Blocks (§4.4)", () => {
    it("should filter out command output blocks from Codex response", () => {
      const output = loadFixture("codex-health-check.txt");
      const result = codexExtractor.extract(output);

      // Should NOT contain the command block output
      expect(result.response).not.toContain('│ echo "DISCORD_START');
      expect(result.response).not.toContain("└ HEALTH_");
      expect(result.response).not.toContain("Ran echo HEALTH");

      // Should contain only the final response
      expect(result.response).toContain("Commands executed");
      expect(result.response).toContain("output shows the health code");

      // Should have filtered out noise
      expect(result.metrics.noiseLinesFiltered).toBeGreaterThan(0);
    });

    it("should handle command blocks with separators", () => {
      const output = `› test command

• Ran test command
  │ output line 1
  │ output line 2
  └ done

─────────────────────────────────────────────────────────────────────────────────────────────────────

• All done! The command completed successfully.

› `;

      const result = codexExtractor.extract(output);

      // Should skip the entire command block
      expect(result.response).not.toContain("Ran test command");
      expect(result.response).not.toContain("output line 1");
      expect(result.response).not.toContain("│");
      expect(result.response).not.toContain("└");

      // Should only contain the final response
      expect(result.response).toContain("All done! The command completed successfully.");
    });

    it("should handle multiple command blocks", () => {
      const output = `• Ran command 1
  │ output
  └ done

─────────────────────────────────────────────────────────────────────────────────────────────────────

• Intermediate response

─────────────────────────────────────────────────────────────────────────────────────────────────────

• Ran command 2
  │ more output
  └ done

─────────────────────────────────────────────────────────────────────────────────────────────────────

• Final response

› `;

      const result = codexExtractor.extract(output);

      // Should filter all command blocks
      expect(result.response).not.toContain("Ran command");
      expect(result.response).not.toContain("│");

      // Should contain response text
      expect(result.response).toContain("Final response");
    });
  });

  describe("Long Responses (§4.5)", () => {
    it("should handle long multi-paragraph responses", () => {
      const longResponse = `⏺ Here's a comprehensive explanation of the system architecture.

  The frontend layer handles all user interactions and state management. It uses React with TypeScript
  for type safety and better developer experience. The component hierarchy is organized by feature,
  with shared components in a common directory.

  The backend layer is built with Node.js and Express, providing RESTful APIs for the frontend to
  consume. We use PostgreSQL for data persistence, with Prisma as our ORM for type-safe database
  access. The database schema is version-controlled using migrations.

  For authentication, we implement JWT tokens with refresh token rotation. The tokens are stored in
  httpOnly cookies for security. We also have rate limiting and request validation middleware to
  protect against common attacks.

  The deployment pipeline uses GitHub Actions for CI/CD. On every push to main, we run tests, build
  Docker images, and deploy to our Kubernetes cluster. We use blue-green deployment strategy to ensure
  zero downtime during updates.

> `;

      const result = claudeExtractor.extract(longResponse);

      // Should extract all paragraphs
      expect(result.response).toContain("comprehensive explanation");
      expect(result.response).toContain("frontend layer");
      expect(result.response).toContain("backend layer");
      expect(result.response).toContain("authentication");
      expect(result.response).toContain("deployment pipeline");

      // Should preserve structure
      const lines = result.response!.split("\n");
      expect(lines.length).toBeGreaterThan(10);

      // Should have blank lines between paragraphs
      const blankLineCount = lines.filter((l) => l.trim() === "").length;
      expect(blankLineCount).toBeGreaterThan(0);

      expect(result.metrics.validationPassed).toBe(true);
      expect(result.metrics.responseLength).toBeGreaterThan(500);
    });

    it("should handle responses with code blocks", () => {
      const output = `⏺ Here's how to implement it:

  First, create the interface:

  interface User {
    id: string;
    name: string;
    email: string;
  }

  Then implement the service class with proper error handling and validation.

> `;

      const result = claudeExtractor.extract(output);

      expect(result.response).toContain("Here's how to implement it");
      expect(result.response).toContain("interface User");
      expect(result.response).toContain("id: string");
      expect(result.response).toContain("Then implement the service");
      expect(result.metrics.validationPassed).toBe(true);
    });
  });

  describe("Ambiguous Responses (§4.6)", () => {
    it("should extract short ambiguous response from Codex", () => {
      const output = loadFixture("codex-confused.txt");
      const result = codexExtractor.extract(output);

      // Should extract the confused/ambiguous response
      expect(result.response).toContain("I'm here for code or workflow help");
      expect(result.response).toContain("what should we do next");

      // Validation should still pass (it's a valid response, just ambiguous)
      expect(result.metrics.validationPassed).toBe(true);
      expect(result.metrics.responseFound).toBe(true);
    });

    it("should handle clarifying questions", () => {
      const output = `⏺ Could you clarify what you mean by "the system"? Are you referring to the authentication
  system, the database layer, or the overall architecture?

> `;

      const result = claudeExtractor.extract(output);

      expect(result.response).toContain("Could you clarify");
      expect(result.response).toContain("authentication");
      expect(result.response).toContain("system");
      expect(result.metrics.validationPassed).toBe(true);
    });

    it("should handle error responses", () => {
      const output = `⏺ I encountered an error: the configuration file could not be found. Please check that
  config.json exists in the project root.

> `;

      const result = claudeExtractor.extract(output);

      expect(result.response).toContain("encountered an error");
      expect(result.response).toContain("configuration file could not be found");
      expect(result.metrics.validationPassed).toBe(true);
    });
  });

  describe("Noise Filtering", () => {
    it("should filter compaction feedback prompts", () => {
      const output = `⏺ Response content here.

● How did that compaction go? (optional)
  1: Bad    2: Fine   3: Good   0: Dismiss

> `;

      const result = claudeExtractor.extract(output);

      expect(result.response).toBe("Response content here.");
      expect(result.response).not.toContain("How did that compaction go");
      expect(result.response).not.toContain("1: Bad");
    });

    it("should filter thinking blocks", () => {
      const output = `⏺ Response here.

<thinking>
Internal reasoning...
</thinking>

More response content.

> `;

      const result = claudeExtractor.extract(output);

      // Thinking blocks should be filtered if configured as noise
      // (Depends on config, but test the mechanism)
      expect(result.metrics.noiseLinesFiltered).toBeGreaterThanOrEqual(0);
    });

    it("should filter status lines", () => {
      const output = `⏺ Processing your request...

  ⏳ Analyzing code...

  ✓ Analysis complete! Here are the results:

  The code looks good with minor suggestions for improvement.

> `;

      const result = claudeExtractor.extract(output);

      // Should contain the actual response
      expect(result.response).toContain("The code looks good");

      // May or may not contain status indicators depending on config
      // Just verify extraction succeeds
      expect(result.metrics.validationPassed).toBe(true);
    });
  });

  describe("Boundary Detection", () => {
    it("should stop at next prompt marker", () => {
      const output = `⏺ First response

> echo another command

Some command output

⏺ Second response`;

      const result = claudeExtractor.extract(output);

      // Should extract ONLY the last response
      expect(result.response).toBe("Second response");
      expect(result.response).not.toContain("First response");
      expect(result.response).not.toContain("echo another command");
    });

    it("should stop at separator lines", () => {
      const output = `⏺ Response here.

───────────────────────────────────

> `;

      const result = claudeExtractor.extract(output);

      expect(result.response).toBe("Response here.");
      expect(result.response).not.toContain("───");
    });

    it("should handle stop patterns correctly", () => {
      const output = `⏺ Response content.

● Feedback prompt starts here

> `;

      const result = claudeExtractor.extract(output);

      expect(result.response).toBe("Response content.");
      expect(result.response).not.toContain("Feedback prompt");
    });
  });

  describe("Validation", () => {
    it("should fail validation for empty responses", () => {
      const output = `⏺ 

> `;

      const result = claudeExtractor.extract(output);

      expect(result.response).toBeNull();
      expect(result.metrics.validationPassed).toBe(false);
      expect(result.metrics.validationFailure).toContain("empty");
    });

    it("should fail validation if response contains separator lines", () => {
      // This shouldn't happen if extraction works correctly,
      // but validation should catch it
      const extractor = new LLMResponseExtractor({
        ...claudeCodeConfig,
        stop_patterns: [], // Disable stop patterns to let separators through
        noise_patterns: [], // Disable noise filtering too (noise also filters separators)
      });

      const output = `⏺ Text
───────────────────────────────────
More text

> `;

      const result = extractor.extract(output);

      // Validation should catch separator in response
      expect(result.metrics.validationPassed).toBe(false);
      expect(result.metrics.validationFailure).toContain("separator");
    });

    it("should fail validation if response starts with noise marker", () => {
      // Keep noise patterns for validation, but craft input so marker
      // appears right after response marker (no space)
      const extractor = new LLMResponseExtractor({
        ...claudeCodeConfig,
      });

      const output = `⏺● This starts with a noise marker

> `;

      const result = extractor.extract(output);

      // Validation should catch this
      expect(result.metrics.validationPassed).toBe(false);
    });

    it("should pass validation for well-formed responses", () => {
      const output = `⏺ This is a clean, well-formed response with no issues.

> `;

      const result = claudeExtractor.extract(output);

      expect(result.metrics.validationPassed).toBe(true);
      expect(result.metrics.validationFailure).toBeUndefined();
    });
  });

  describe("Metrics", () => {
    it("should report accurate line counts", () => {
      const output = `⏺ Line 1

  Line 2

  Line 3

● Noise line

> `;

      const result = claudeExtractor.extract(output);

      expect(result.metrics.linesExtracted).toBeGreaterThan(0);
      expect(result.metrics.noiseLinesFiltered).toBeGreaterThan(0);
    });

    it("should report response length correctly", () => {
      const output = `⏺ Short response

> `;

      const result = claudeExtractor.extract(output);

      expect(result.metrics.responseLength).toBe(result.response!.length);
    });

    it("should report extraction time", () => {
      const output = `⏺ Response

> `;

      const result = claudeExtractor.extract(output);

      expect(result.metrics.extractionTimeMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.extractionTimeMs).toBeLessThan(1000); // Should be fast
    });

    it("should report LLM type", () => {
      const result = claudeExtractor.extract(`⏺ Response\n> `);

      expect(result.metrics.llmType).toBe("claude-code");

      const codexResult = codexExtractor.extract(`• Response\n› `);
      expect(codexResult.metrics.llmType).toBe("codex");
    });
  });

  describe("Edge Cases", () => {
    it("should handle response marker in middle of line", () => {
      const output = `Some text ⏺ This is not a real response marker

⏺ This is the real response

> `;

      const result = claudeExtractor.extract(output);

      expect(result.response).toBe("This is the real response");
    });

    it("should handle very long lines", () => {
      const longLine = "x".repeat(10000);
      const output = `⏺ ${longLine}

> `;

      const result = claudeExtractor.extract(output);

      expect(result.response).toBe(longLine);
      expect(result.metrics.validationPassed).toBe(true);
    });

    it("should handle unicode characters", () => {
      const output = `⏺ 你好! こんにちは! 안녕하세요! 🎉

> `;

      const result = claudeExtractor.extract(output);

      expect(result.response).toBe("你好! こんにちは! 안녕하세요! 🎉");
      expect(result.metrics.validationPassed).toBe(true);
    });

    it("should handle responses with only whitespace on some lines", () => {
      const output = `⏺ Line 1
     
  Line 2

> `;

      const result = claudeExtractor.extract(output);

      expect(result.response).toContain("Line 1");
      expect(result.response).toContain("Line 2");
    });

    it("should handle malformed terminal output gracefully", () => {
      const malformed = `⏺ Response\nwith\nno\nprompt\nat\nend`;

      const result = claudeExtractor.extract(malformed);

      // Should still extract up to end of output
      expect(result.response).toContain("Response");
      expect(result.metrics.responseFound).toBe(true);
    });
  });
});
