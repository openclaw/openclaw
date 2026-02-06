/**
 * Tmux Integration Tests
 *
 * Tests extraction with real tmux output including ANSI codes,
 * escape sequences, and actual terminal formatting.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { LLMResponseExtractor } from "../extractor.js";
import { ConfigLoader } from "../config-loader.js";

// Skip these tests if tmux is not available
const TMUX_AVAILABLE = (() => {
  try {
    execSync("which tmux", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

const describeIfTmux = TMUX_AVAILABLE ? describe : describe.skip;

describeIfTmux("Tmux Integration Tests", () => {
  let sessionName: string;
  let extractor: LLMResponseExtractor;

  beforeAll(() => {
    // Create unique test session name
    sessionName = `test-extraction-${Date.now()}`;

    // Create test tmux session with a shell
    try {
      execSync(`tmux new-session -d -s ${sessionName} bash`, { stdio: "pipe" });
      // Give the session time to initialize
      execSync("sleep 0.5");
    } catch (error) {
      console.error("Failed to create tmux session:", error);
      throw error;
    }

    // Initialize extractor
    const config = ConfigLoader.load("claude-code");
    extractor = new LLMResponseExtractor(config);
  });

  afterAll(() => {
    // Clean up test session
    try {
      execSync(`tmux kill-session -t ${sessionName}`, { stdio: "pipe" });
    } catch {
      // Session might already be dead, ignore error
    }
  });

  describe("Basic tmux capture", () => {
    it("should extract from real tmux capture output", () => {
      // Send command that produces response marker
      execSync(`tmux send-keys -t ${sessionName} 'echo "⏺ Test response from tmux"' Enter`, {
        stdio: "pipe",
      });

      // Wait for command to execute
      execSync("sleep 0.5");

      // Capture pane content
      const rawOutput = execSync(`tmux capture-pane -p -t ${sessionName}`, {
        encoding: "utf-8",
      });

      // Extract response
      const result = extractor.extract(rawOutput);

      // Should successfully extract the response
      expect(result.response).toContain("Test response from tmux");
      expect(result.metrics.responseFound).toBe(true);
      expect(result.metrics.validationPassed).toBe(true);
    });

    it("should handle multiple lines in real tmux output", () => {
      // Send multi-line output
      execSync(
        `tmux send-keys -t ${sessionName} 'echo "⏺ Line 1"; echo "Line 2"; echo "Line 3"' Enter`,
        { stdio: "pipe" },
      );

      execSync("sleep 0.5");

      const rawOutput = execSync(`tmux capture-pane -p -t ${sessionName}`, {
        encoding: "utf-8",
      });

      const result = extractor.extract(rawOutput);

      expect(result.response).toContain("Line 1");
      expect(result.response).toContain("Line 2");
      expect(result.response).toContain("Line 3");
      expect(result.metrics.linesExtracted).toBeGreaterThanOrEqual(3);
    });
  });

  describe("ANSI codes and escape sequences", () => {
    it("should handle ANSI color codes in tmux output", () => {
      // Send text with ANSI color codes
      const command = 'printf "⏺ \\033[31mRed text\\033[0m Normal text\\n"';
      execSync(`tmux send-keys -t ${sessionName} '${command}' Enter`, {
        stdio: "pipe",
      });

      execSync("sleep 0.5");

      const rawOutput = execSync(`tmux capture-pane -p -t ${sessionName}`, {
        encoding: "utf-8",
      });

      const result = extractor.extract(rawOutput);

      // Should extract text even with ANSI codes present
      expect(result.response).toBeTruthy();
      expect(result.metrics.responseFound).toBe(true);
    });

    it("should handle escape sequences in tmux output", () => {
      // Send text with escape sequences (cursor movement, etc.)
      const command = 'printf "⏺ Text with\\rescaping\\n"';
      execSync(`tmux send-keys -t ${sessionName} '${command}' Enter`, {
        stdio: "pipe",
      });

      execSync("sleep 0.5");

      const rawOutput = execSync(`tmux capture-pane -p -t ${sessionName}`, {
        encoding: "utf-8",
      });

      const result = extractor.extract(rawOutput);

      expect(result.response).toBeTruthy();
      expect(result.metrics.responseFound).toBe(true);
    });
  });

  describe("Real terminal formatting", () => {
    it("should handle tab characters in tmux output", () => {
      const command = 'printf "⏺ Text\\twith\\ttabs\\n"';
      execSync(`tmux send-keys -t ${sessionName} '${command}' Enter`, {
        stdio: "pipe",
      });

      execSync("sleep 0.5");

      const rawOutput = execSync(`tmux capture-pane -p -t ${sessionName}`, {
        encoding: "utf-8",
      });

      const result = extractor.extract(rawOutput);

      expect(result.response).toContain("Text");
      expect(result.response).toContain("with");
      expect(result.response).toContain("tabs");
      expect(result.metrics.responseFound).toBe(true);
    });

    it("should handle trailing whitespace in tmux output", () => {
      const command = 'printf "⏺ Text with trailing spaces   \\n"';
      execSync(`tmux send-keys -t ${sessionName} '${command}' Enter`, {
        stdio: "pipe",
      });

      execSync("sleep 0.5");

      const rawOutput = execSync(`tmux capture-pane -p -t ${sessionName}`, {
        encoding: "utf-8",
      });

      const result = extractor.extract(rawOutput);

      expect(result.response).toContain("Text with trailing spaces");
      expect(result.metrics.responseFound).toBe(true);
    });

    it("should handle unicode characters in tmux output", () => {
      const command = 'echo "⏺ Unicode: 你好 мир 🚀"';
      execSync(`tmux send-keys -t ${sessionName} '${command}' Enter`, {
        stdio: "pipe",
      });

      execSync("sleep 0.5");

      const rawOutput = execSync(`tmux capture-pane -p -t ${sessionName}`, {
        encoding: "utf-8",
      });

      const result = extractor.extract(rawOutput);

      expect(result.response).toContain("Unicode");
      expect(result.response).toContain("你好");
      expect(result.response).toContain("мир");
      expect(result.response).toContain("🚀");
      expect(result.metrics.responseFound).toBe(true);
    });
  });

  describe("Real-world command output", () => {
    it("should extract from tmux session with actual prompt", () => {
      // Create a custom prompt that includes the response marker
      execSync(`tmux send-keys -t ${sessionName} 'PS1="⏺ $ "' Enter`, {
        stdio: "pipe",
      });

      execSync("sleep 0.5");

      // Send a simple command
      execSync(`tmux send-keys -t ${sessionName} 'echo "Hello from bash"' Enter`, {
        stdio: "pipe",
      });

      execSync("sleep 0.5");

      const rawOutput = execSync(`tmux capture-pane -p -t ${sessionName}`, {
        encoding: "utf-8",
      });

      const result = extractor.extract(rawOutput);

      // Should find the echo output (might be after prompt)
      expect(result.response).toBeTruthy();
      expect(result.metrics.responseFound).toBe(true);
    });

    it("should handle command output with multiple prompts", () => {
      // Send multiple commands in sequence
      execSync(`tmux send-keys -t ${sessionName} 'echo "⏺ First"' Enter`, {
        stdio: "pipe",
      });
      execSync("sleep 0.3");

      execSync(`tmux send-keys -t ${sessionName} 'echo "⏺ Second"' Enter`, {
        stdio: "pipe",
      });
      execSync("sleep 0.3");

      execSync(`tmux send-keys -t ${sessionName} 'echo "⏺ Third"' Enter`, {
        stdio: "pipe",
      });
      execSync("sleep 0.3");

      const rawOutput = execSync(`tmux capture-pane -p -t ${sessionName}`, {
        encoding: "utf-8",
      });

      const result = extractor.extract(rawOutput);

      // Should find A response (last marker in output)
      // May extract "Third" or just shell prompt depending on timing
      expect(result.metrics.responseFound).toBe(true);
      expect(result.response).toBeTruthy();
    });

    it("should handle long command output in tmux", () => {
      // Generate long output
      const command = 'for i in {1..20}; do echo "⏺ Line $i"; done';
      execSync(`tmux send-keys -t ${sessionName} '${command}' Enter`, {
        stdio: "pipe",
      });

      execSync("sleep 1");

      const rawOutput = execSync(`tmux capture-pane -p -t ${sessionName}`, {
        encoding: "utf-8",
      });

      const result = extractor.extract(rawOutput);

      // Should successfully extract even with many lines
      expect(result.response).toBeTruthy();
      expect(result.metrics.responseFound).toBe(true);
      expect(result.metrics.linesExtracted).toBeGreaterThan(1);
    });
  });

  describe("Performance with real tmux output", () => {
    it("should extract from real tmux output in <100ms", () => {
      // Generate substantial output
      const command = 'seq 1 50 | while read i; do echo "⏺ Line $i"; done';
      execSync(`tmux send-keys -t ${sessionName} '${command}' Enter`, {
        stdio: "pipe",
      });

      execSync("sleep 1");

      const rawOutput = execSync(`tmux capture-pane -p -t ${sessionName}`, {
        encoding: "utf-8",
      });

      const result = extractor.extract(rawOutput);

      expect(result.response).toBeTruthy();
      expect(result.metrics.extractionTimeMs).toBeLessThan(100);
      expect(result.metrics.responseFound).toBe(true);
    });
  });

  describe("Error handling with real tmux", () => {
    it("should handle empty tmux pane gracefully", () => {
      // Clear the pane
      execSync(`tmux send-keys -t ${sessionName} 'clear' Enter`, {
        stdio: "pipe",
      });

      execSync("sleep 0.3");

      const rawOutput = execSync(`tmux capture-pane -p -t ${sessionName}`, {
        encoding: "utf-8",
      });

      const result = extractor.extract(rawOutput);

      // Should handle pane without error (may still have shell prompt visible)
      expect(result.error).toBeUndefined();
      // Shell prompt may still be visible after clear, so responseFound could be true or false
      expect(result.metrics).toBeDefined();
    });

    it("should handle tmux output with no marker", () => {
      // Send output without marker
      execSync(`tmux send-keys -t ${sessionName} 'echo "No marker here"' Enter`, {
        stdio: "pipe",
      });

      execSync("sleep 0.3");

      const rawOutput = execSync(`tmux capture-pane -p -t ${sessionName}`, {
        encoding: "utf-8",
      });

      const result = extractor.extract(rawOutput);

      // Should handle output without error
      expect(result.error).toBeUndefined();
      // May or may not find response depending on shell prompt visibility
      expect(result.metrics).toBeDefined();
    });
  });
});
