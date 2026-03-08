import { describe, expect, it } from "vitest";
import {
  calculateDebounceMultiplier,
  createSmartDebounceResolver,
  DEFAULT_SMART_DEBOUNCE_CONFIG,
  extractMessageText,
  isCompleteMessage,
  isIncompleteMessage,
  resolveSmartDebounceMs,
  type SmartDebounceConfig,
} from "./smart-debounce.js";

describe("smart-debounce", () => {
  describe("isIncompleteMessage", () => {
    it("detects ellipsis as incomplete", () => {
      expect(isIncompleteMessage("帮我写一个...", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
      expect(isIncompleteMessage("wait...", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
    });

    it("detects Chinese comma as incomplete", () => {
      expect(isIncompleteMessage("然后，", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
      expect(isIncompleteMessage("继续，帮我", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(false);
    });

    it("detects enumeration comma as incomplete", () => {
      expect(isIncompleteMessage("还有、", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
    });

    it("detects English comma as incomplete", () => {
      expect(isIncompleteMessage("and then,", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
    });

    it("detects 'continue' as incomplete", () => {
      expect(isIncompleteMessage("continue", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
      expect(isIncompleteMessage("please continue", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
    });

    it("detects '待续' as incomplete", () => {
      expect(isIncompleteMessage("待续", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
      expect(isIncompleteMessage("未完待续", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
    });

    it("returns false for complete messages", () => {
      expect(isIncompleteMessage("帮我写一个", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(false);
      expect(isIncompleteMessage("完成了。", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(false);
      expect(isIncompleteMessage("Hello world", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(false);
    });

    it("returns false for short messages", () => {
      expect(isIncompleteMessage("..", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(false);
      expect(isIncompleteMessage("a", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(false);
    });
  });

  describe("isCompleteMessage", () => {
    it("detects Chinese period as complete", () => {
      expect(isCompleteMessage("完成了。", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
    });

    it("detects Chinese question mark as complete", () => {
      expect(isCompleteMessage("好吗？", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
    });

    it("detects English period as complete", () => {
      expect(isCompleteMessage("Done.", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
      expect(isCompleteMessage("Hello world.", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
    });

    it("detects English question mark as complete", () => {
      expect(isCompleteMessage("Is it done?", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
    });

    it("detects exclamation mark as complete", () => {
      expect(isCompleteMessage("Great!", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
      expect(isCompleteMessage("太棒了！", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
    });

    it("detects 'done' as complete", () => {
      expect(isCompleteMessage("done", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
      expect(isCompleteMessage("I am done", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
    });

    it("detects '完了' as complete", () => {
      expect(isCompleteMessage("完了", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
      expect(isCompleteMessage("做完了", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(true);
    });

    it("returns false for incomplete messages", () => {
      expect(isCompleteMessage("继续...", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(false);
      expect(isCompleteMessage("and then", DEFAULT_SMART_DEBOUNCE_CONFIG)).toBe(false);
    });
  });

  describe("calculateDebounceMultiplier", () => {
    it("returns higher multiplier for incomplete messages", () => {
      const multiplier = calculateDebounceMultiplier(
        "帮我写一个...",
        DEFAULT_SMART_DEBOUNCE_CONFIG,
      );
      expect(multiplier).toBeGreaterThan(1);
    });

    it("returns lower multiplier for complete messages", () => {
      const multiplier = calculateDebounceMultiplier("完成了。", DEFAULT_SMART_DEBOUNCE_CONFIG);
      expect(multiplier).toBeLessThan(1);
    });

    it("returns 1.0 for neutral messages", () => {
      const multiplier = calculateDebounceMultiplier("Hello world", DEFAULT_SMART_DEBOUNCE_CONFIG);
      expect(multiplier).toBe(1.0);
    });

    it("respects minMessageLength", () => {
      const config: SmartDebounceConfig = {
        ...DEFAULT_SMART_DEBOUNCE_CONFIG,
        minMessageLength: 10,
      };
      const multiplier = calculateDebounceMultiplier("Hi", config);
      expect(multiplier).toBeGreaterThan(1); // Too short, treated as incomplete
    });
  });

  describe("resolveSmartDebounceMs", () => {
    it("extends debounce for incomplete messages", () => {
      const baseMs = 2000;
      const result = resolveSmartDebounceMs(baseMs, "帮我写一个...", DEFAULT_SMART_DEBOUNCE_CONFIG);
      expect(result).toBeGreaterThan(baseMs);
    });

    it("reduces debounce for complete messages", () => {
      const baseMs = 2000;
      const result = resolveSmartDebounceMs(baseMs, "完成了。", DEFAULT_SMART_DEBOUNCE_CONFIG);
      expect(result).toBeLessThan(baseMs);
    });

    it("returns base for neutral messages", () => {
      const baseMs = 2000;
      const result = resolveSmartDebounceMs(baseMs, "Hello", DEFAULT_SMART_DEBOUNCE_CONFIG);
      expect(result).toBe(baseMs);
    });

    it("respects maxDebounceMultiplier", () => {
      const baseMs = 2000;
      const config: SmartDebounceConfig = {
        ...DEFAULT_SMART_DEBOUNCE_CONFIG,
        maxDebounceMultiplier: 2,
      };
      const result = resolveSmartDebounceMs(baseMs, "继续...", config);
      expect(result).toBeLessThanOrEqual(baseMs * 2);
    });

    it("returns base when disabled", () => {
      const baseMs = 2000;
      const config: SmartDebounceConfig = {
        ...DEFAULT_SMART_DEBOUNCE_CONFIG,
        enabled: false,
      };
      const result = resolveSmartDebounceMs(baseMs, "继续...", config);
      expect(result).toBe(baseMs);
    });
  });

  describe("extractMessageText", () => {
    it("extracts text from object with text field", () => {
      const item = { text: "Hello" };
      expect(extractMessageText(item)).toBe("Hello");
    });

    it("extracts text from object with content field", () => {
      const item = { content: "Hello" };
      expect(extractMessageText(item)).toBe("Hello");
    });

    it("extracts text from object with body field", () => {
      const item = { body: "Hello" };
      expect(extractMessageText(item)).toBe("Hello");
    });

    it("extracts text from nested msg object (Telegram style)", () => {
      const item = { msg: { text: "Hello" } };
      expect(extractMessageText(item)).toBe("Hello");
    });

    it("extracts caption from nested msg object", () => {
      const item = { msg: { caption: "Photo caption" } };
      expect(extractMessageText(item)).toBe("Photo caption");
    });

    it("returns string directly", () => {
      expect(extractMessageText("Hello")).toBe("Hello");
    });

    it("returns empty string for null", () => {
      expect(extractMessageText(null)).toBe("");
    });

    it("returns empty string for undefined", () => {
      expect(extractMessageText(undefined)).toBe("");
    });
  });

  describe("createSmartDebounceResolver", () => {
    it("creates a resolver function", () => {
      const resolver = createSmartDebounceResolver(2000, DEFAULT_SMART_DEBOUNCE_CONFIG);
      expect(typeof resolver).toBe("function");
    });

    it("resolver returns extended time for incomplete messages", () => {
      const resolver = createSmartDebounceResolver(2000, DEFAULT_SMART_DEBOUNCE_CONFIG);
      const result = resolver("帮我写一个...");
      expect(result).toBeGreaterThan(2000);
    });

    it("resolver uses custom extractText function", () => {
      const resolver = createSmartDebounceResolver(
        2000,
        DEFAULT_SMART_DEBOUNCE_CONFIG,
        (item: { message: string }) => item.message,
      );
      const result = resolver({ message: "完成了。" });
      expect(result).toBeLessThan(2000);
    });

    it("resolver respects disabled config", () => {
      const config: SmartDebounceConfig = {
        ...DEFAULT_SMART_DEBOUNCE_CONFIG,
        enabled: false,
      };
      const resolver = createSmartDebounceResolver(2000, config);
      const result = resolver("继续...");
      expect(result).toBe(2000);
    });
  });
});
