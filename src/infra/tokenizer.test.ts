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
    it("should report correct enabled status from config", () => {
      const config = getConfig();
      const expected =
        process.env.OPENCLAW_TOKENIZER_ENABLED === "1" ||
        process.env.OPENCLAW_TOKENIZER_ENABLED === "true";
      expect(config.enabled).toBe(expected);
    });

    it("should estimate tokens using chars * 0.4, only counting content", () => {
      const message = {
        role: "user",
        content: "Hello, world!",
      };
      const tokens = estimateTokensWithTokenizer(message);
      // 默认模式只计算 content: "Hello, world!" = 13 chars -> floor(13 * 0.4) = 5
      // 这与原始 SDK 的 estimateTokens 行为一致
      expect(tokens).toBe(5);
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

    it("should handle undefined content", () => {
      const message = {
        role: "user",
      };
      const tokens = estimateTokensWithTokenizer(message);
      // undefined content 返回 0
      expect(tokens).toBe(0);
    });

    it("should handle null content", () => {
      const message = {
        role: "user",
        content: null,
      };
      const tokens = estimateTokensWithTokenizer(message);
      // null content 返回 0
      expect(tokens).toBe(0);
    });

    it("should handle Chinese text", () => {
      const message = {
        role: "user",
        content: "你好，世界！",
      };
      const tokens = estimateTokensWithTokenizer(message);
      // "你好，世界！" = 6 chars -> floor(6 * 0.4) = 2
      expect(tokens).toBe(2);
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

    it("should handle object content by JSON stringifying", () => {
      const message = {
        role: "user",
        content: { type: "text", text: "Hello" },
      };
      const tokens = estimateTokensWithTokenizer(message);
      // JSON.stringify({ type: "text", text: "Hello" }) = '{"type":"text","text":"Hello"}' = 30 chars
      // floor(30 * 0.4) = 12
      expect(tokens).toBe(12);
    });
  });

  describe("estimateMessagesTokensWithTokenizer", () => {
    it("should estimate tokens for multiple messages", () => {
      const messages = [
        { role: "user", content: "Hello" }, // 5 chars -> floor(5*0.4)=2
        { role: "assistant", content: "Hi" }, // 2 chars -> floor(2*0.4)=0
      ];
      const tokens = estimateMessagesTokensWithTokenizer(messages);
      expect(tokens).toBe(2); // 2 + 0 = 2
    });

    it("should handle empty array", () => {
      const tokens = estimateMessagesTokensWithTokenizer([]);
      expect(tokens).toBe(0);
    });

    it("should cache results", () => {
      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" }, // 8 chars -> floor(8*0.4)=3
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
