import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_FLUSH_PROMPT,
  DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT,
  resolveMemoryFlushSettings,
} from "./memory-flush.js";

describe("memory flush task checkpoint", () => {
  describe("DEFAULT_MEMORY_FLUSH_PROMPT", () => {
    it("includes task state extraction language", () => {
      expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("active task");
      expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("task name");
      expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("current step");
      expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("pending actions");
    });

    it("instructs to use memory_store with core category and importance 1.0", () => {
      expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("memory_store");
      expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("category 'core'");
      expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("importance 1.0");
    });
  });

  describe("DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT", () => {
    it("includes CRITICAL instruction about active tasks", () => {
      expect(DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT).toContain("CRITICAL");
      expect(DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT).toContain("active task");
    });

    it("instructs to save task state with core category", () => {
      expect(DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT).toContain("memory_store");
      expect(DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT).toContain("category='core'");
      expect(DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT).toContain("importance=1.0");
    });

    it("mentions task continuity after compaction", () => {
      expect(DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT).toContain("task continuity after compaction");
    });
  });

  describe("resolveMemoryFlushSettings", () => {
    it("returns prompts containing task-related keywords by default", () => {
      const settings = resolveMemoryFlushSettings();
      expect(settings).not.toBeNull();
      expect(settings?.prompt).toContain("active task");
      expect(settings?.prompt).toContain("memory_store");
      expect(settings?.systemPrompt).toContain("CRITICAL");
      expect(settings?.systemPrompt).toContain("task continuity");
    });

    it("preserves task checkpoint language alongside existing content", () => {
      const settings = resolveMemoryFlushSettings();
      expect(settings).not.toBeNull();
      // Original content still present
      expect(settings?.prompt).toContain("Pre-compaction memory flush");
      expect(settings?.prompt).toContain("durable memories");
      // New task checkpoint content also present
      expect(settings?.prompt).toContain("current step");
      expect(settings?.prompt).toContain("pending actions");
    });
  });
});
