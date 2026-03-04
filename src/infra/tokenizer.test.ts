import { describe, it, expect, beforeEach } from "vitest";
import {
  estimateTokensWithTokenizer,
  estimateMessagesTokensWithTokenizer,
  clearTokenizerCache,
  getTokenizerCacheStats,
  getConfig,
} from "./tokenizer.js";

describe("tokenizer", () => {
  beforeEach(() => {
    clearTokenizerCache();
  });

  describe("default behavior (char estimation: chars * 0.4)", () => {
    it("should use char estimation by default", () => {
      const config = getConfig();
      // 默认应该是禁用的，使用字符估算
      expect(config.enabled).toBe(false);
    });

    it("should estimate tokens using chars * 0.4", () => {
      const message = {
        role: "user",
        content: "Hello, world!",
      };
      const tokens = estimateTokensWithTokenizer(message);
      // "user: Hello, world!" = 19 chars -> floor(19 * 0.4) = 7
      expect(tokens).toBe(7);
    });

    it("should handle empty content", () => {
      const message = {
        role: "user",
        content: "",
      };
      const tokens = estimateTokensWithTokenizer(message);
      // 空内容返回 0
      expect(tokens).toBe(0);
    });

    it("should handle Chinese text", () => {
      const message = {
        role: "user",
        content: "你好，世界！",
      };
      const tokens = estimateTokensWithTokenizer(message);
      // "user: 你好，世界！" = 11 chars -> floor(11 * 0.4) = 4
      expect(tokens).toBe(4);
    });

    it("should cache results", () => {
      const message = {
        role: "user",
        content: "Test message for caching",
      };
      const stats1 = getTokenizerCacheStats();
      const first = estimateTokensWithTokenizer(message);
      const stats2 = getTokenizerCacheStats();
      const second = estimateTokensWithTokenizer(message);
      const stats3 = getTokenizerCacheStats();
      expect(first).toBe(second);
      expect(stats3.size).toBe(stats2.size);
      expect(stats2.size).toBeGreaterThan(stats1.size);
    });

    it("should handle large messages", () => {
      const largeContent = "Hello, world! ".repeat(1000);
      const message = {
        role: "user",
        content: largeContent,
      };
      const tokens = estimateTokensWithTokenizer(message);
      // ~14000 chars * 0.4 = ~5600
      expect(tokens).toBeGreaterThan(5000);
      expect(tokens).toBeLessThan(6000);
    });
  });

  describe("estimateMessagesTokensWithTokenizer", () => {
    it("should estimate tokens for multiple messages", () => {
      const messages = [
        { role: "user", content: "Hello" }, // "user: Hello" = 11 chars -> floor(11*0.4)=4
        { role: "assistant", content: "Hi" }, // "assistant: Hi" = 13 chars -> floor(13*0.4)=5
      ];
      const tokens = estimateMessagesTokensWithTokenizer(messages);
      expect(tokens).toBe(9); // 4 + 5 = 9
    });

    it("should handle empty array", () => {
      const tokens = estimateMessagesTokensWithTokenizer([]);
      expect(tokens).toBe(0);
    });

    it("should cache whole array results", () => {
      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ];
      getTokenizerCacheStats(); // check initial stats
      const first = estimateMessagesTokensWithTokenizer(messages);
      const stats2 = getTokenizerCacheStats();
      const second = estimateMessagesTokensWithTokenizer(messages);
      const stats3 = getTokenizerCacheStats();
      expect(first).toBe(second);
      expect(stats3.size).toBe(stats2.size);
    });
  });

  describe("configuration", () => {
    it("should export getConfig function", () => {
      const config = getConfig();
      expect(config).toHaveProperty("enabled");
      expect(config).toHaveProperty("provider");
      expect(config).toHaveProperty("model");
    });
  });
});

// 注意：要测试 tokenizer 模式，需要设置环境变量：
// OPENCLAW_TOKENIZER_ENABLED=1
// 然后运行测试
