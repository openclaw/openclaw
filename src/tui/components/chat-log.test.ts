import { describe, expect, it } from "vitest";
import { ChatLog } from "./chat-log.js";

describe("ChatLog", () => {
  describe("finalizeAssistant", () => {
    it("does not add a component when text is NO_REPLY and no streaming entry exists", () => {
      const log = new ChatLog();
      const childrenBefore = log.children.length;

      log.finalizeAssistant("NO_REPLY", "run-1");

      // No child should have been added
      expect(log.children.length).toBe(childrenBefore);
    });

    it("removes streaming entry when text is NO_REPLY and a streaming entry exists", () => {
      const log = new ChatLog();
      log.startAssistant("thinking...", "run-2");
      const childrenAfterStart = log.children.length;
      expect(childrenAfterStart).toBeGreaterThan(0);

      log.finalizeAssistant("NO_REPLY", "run-2");

      // The streaming component should have been removed
      expect(log.children.length).toBe(childrenAfterStart - 1);
    });

    it("adds a component for normal (non-silent) text without a streaming entry", () => {
      const log = new ChatLog();
      const childrenBefore = log.children.length;

      log.finalizeAssistant("Hello there!", "run-3");

      expect(log.children.length).toBe(childrenBefore + 1);
    });

    it("updates the existing streaming entry for normal text", () => {
      const log = new ChatLog();
      log.startAssistant("partial...", "run-4");
      const childrenAfterStart = log.children.length;

      log.finalizeAssistant("Full response here.", "run-4");

      // Same number of children — existing component was updated, not removed or duplicated
      expect(log.children.length).toBe(childrenAfterStart);
    });
  });
});
