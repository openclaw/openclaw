import { describe, expect, it, vi } from "vitest";
import { MEMORY_PROMPTS } from "./register.js";

describe("memory-cli", () => {
  describe("MEMORY_PROMPTS", () => {
    it("should have all three layer prompts", () => {
      expect(MEMORY_PROMPTS).toHaveProperty("hourly");
      expect(MEMORY_PROMPTS).toHaveProperty("daily");
      expect(MEMORY_PROMPTS).toHaveProperty("weekly");
    });

    it("should have non-empty prompts", () => {
      expect(MEMORY_PROMPTS.hourly.length).toBeGreaterThan(100);
      expect(MEMORY_PROMPTS.daily.length).toBeGreaterThan(200);
      expect(MEMORY_PROMPTS.weekly.length).toBeGreaterThan(200);
    });

    it("should mention NO_REPLY in all prompts", () => {
      expect(MEMORY_PROMPTS.hourly).toContain("NO_REPLY");
      expect(MEMORY_PROMPTS.daily).toContain("NO_REPLY");
      expect(MEMORY_PROMPTS.weekly).toContain("NO_REPLY");
    });

    it("should mention memory file paths", () => {
      expect(MEMORY_PROMPTS.hourly).toContain("memory/YYYY-MM-DD.md");
      expect(MEMORY_PROMPTS.daily).toContain("memory/YYYY-MM-DD.md");
      expect(MEMORY_PROMPTS.weekly).toContain("MEMORY.md");
    });
  });
});