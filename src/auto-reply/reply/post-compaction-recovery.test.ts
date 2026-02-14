import { describe, expect, it } from "vitest";
import {
  getPostCompactionRecoveryPrompt,
  POST_COMPACTION_RECOVERY_PROMPT,
  prependPostCompactionRecovery,
} from "./post-compaction-recovery.js";

describe("post-compaction-recovery", () => {
  describe("POST_COMPACTION_RECOVERY_PROMPT", () => {
    it("is defined and non-empty", () => {
      expect(POST_COMPACTION_RECOVERY_PROMPT).toBeTruthy();
      expect(POST_COMPACTION_RECOVERY_PROMPT.length).toBeGreaterThan(0);
    });

    it("stays under 200 tokens (rough estimate: <800 chars)", () => {
      // A rough heuristic: 1 token ≈ 4 chars. 200 tokens ≈ 800 chars.
      expect(POST_COMPACTION_RECOVERY_PROMPT.length).toBeLessThan(800);
    });

    it("includes memory_recall instruction", () => {
      expect(POST_COMPACTION_RECOVERY_PROMPT).toContain("memory_recall");
    });

    it("includes TASKS.md instruction", () => {
      expect(POST_COMPACTION_RECOVERY_PROMPT).toContain("TASKS.md");
    });

    it("includes Context Reset notification template", () => {
      expect(POST_COMPACTION_RECOVERY_PROMPT).toContain("Context Reset");
    });
  });

  describe("getPostCompactionRecoveryPrompt", () => {
    it("returns null when entry is undefined", () => {
      expect(getPostCompactionRecoveryPrompt(undefined)).toBeNull();
    });

    it("returns null when needsPostCompactionRecovery is false", () => {
      const entry = {
        sessionId: "test",
        updatedAt: Date.now(),
        needsPostCompactionRecovery: false,
      };
      expect(getPostCompactionRecoveryPrompt(entry)).toBeNull();
    });

    it("returns null when needsPostCompactionRecovery is not set", () => {
      const entry = { sessionId: "test", updatedAt: Date.now() };
      expect(getPostCompactionRecoveryPrompt(entry)).toBeNull();
    });

    it("returns the recovery prompt when needsPostCompactionRecovery is true", () => {
      const entry = {
        sessionId: "test",
        updatedAt: Date.now(),
        needsPostCompactionRecovery: true,
      };
      expect(getPostCompactionRecoveryPrompt(entry)).toBe(POST_COMPACTION_RECOVERY_PROMPT);
    });
  });

  describe("prependPostCompactionRecovery", () => {
    it("returns original body when no recovery needed", () => {
      const body = "Hello, how are you?";
      expect(prependPostCompactionRecovery(body, undefined)).toBe(body);
    });

    it("returns original body when flag is false", () => {
      const body = "Hello, how are you?";
      const entry = {
        sessionId: "test",
        updatedAt: Date.now(),
        needsPostCompactionRecovery: false,
      };
      expect(prependPostCompactionRecovery(body, entry)).toBe(body);
    });

    it("prepends recovery prompt when flag is true", () => {
      const body = "Hello, how are you?";
      const entry = {
        sessionId: "test",
        updatedAt: Date.now(),
        needsPostCompactionRecovery: true,
      };
      const result = prependPostCompactionRecovery(body, entry);
      expect(result).toContain(POST_COMPACTION_RECOVERY_PROMPT);
      expect(result).toContain(body);
      expect(result.indexOf(POST_COMPACTION_RECOVERY_PROMPT)).toBeLessThan(result.indexOf(body));
    });

    it("separates recovery prompt from body with double newline", () => {
      const body = "test message";
      const entry = {
        sessionId: "test",
        updatedAt: Date.now(),
        needsPostCompactionRecovery: true,
      };
      const result = prependPostCompactionRecovery(body, entry);
      expect(result).toBe(`${POST_COMPACTION_RECOVERY_PROMPT}\n\n${body}`);
    });
  });
});
