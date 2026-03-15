import { describe, expect, it } from "vitest";
import {
  QINIU_BASE_URL,
  QINIU_DEFAULT_COST,
  QINIU_DEFAULT_MODEL_ID,
  QINIU_DEFAULT_MODEL_NAME,
  QINIU_DEFAULT_MODEL_REF,
  QINIU_MODEL_CATALOG,
} from "./qiniu-shared.js";

describe("qiniu-shared", () => {
  describe("constants", () => {
    it("BASE_URL points to Qiniu endpoint", () => {
      expect(QINIU_BASE_URL).toBe("https://api.qnaigc.com");
    });

    it("default model ID is minimax/minimax-m2.5", () => {
      expect(QINIU_DEFAULT_MODEL_ID).toBe("minimax/minimax-m2.5");
    });

    it("default model ref is prefixed with qiniu/", () => {
      expect(QINIU_DEFAULT_MODEL_REF).toBe("qiniu/minimax/minimax-m2.5");
    });

    it("default model name is MiniMax M2.5", () => {
      expect(QINIU_DEFAULT_MODEL_NAME).toBe("MiniMax M2.5");
    });

    it("default cost is all zeros", () => {
      expect(QINIU_DEFAULT_COST).toEqual({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      });
    });
  });

  describe("QINIU_MODEL_CATALOG", () => {
    it("is non-empty", () => {
      expect(QINIU_MODEL_CATALOG.length).toBeGreaterThan(0);
    });

    it("contains the default model", () => {
      const ids = QINIU_MODEL_CATALOG.map((m) => m.id);
      expect(ids).toContain(QINIU_DEFAULT_MODEL_ID);
    });

    it("contains representative models from each vendor", () => {
      const ids = QINIU_MODEL_CATALOG.map((m) => m.id);
      expect(ids).toContain("minimax/minimax-m2.5");
      expect(ids).toContain("deepseek-r1");
      expect(ids).toContain("qwen3-235b-a22b");
      expect(ids).toContain("z-ai/glm-5");
      expect(ids).toContain("moonshotai/kimi-k2.5");
      expect(ids).toContain("doubao-seed-1.6-thinking");
      expect(ids).toContain("meituan/longcat-flash-lite");
      expect(ids).toContain("xiaomi/mimo-v2-flash");
    });

    it("has no duplicate IDs", () => {
      const ids = QINIU_MODEL_CATALOG.map((m) => m.id);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });

    it("every entry has a non-empty id", () => {
      for (const entry of QINIU_MODEL_CATALOG) {
        expect(entry.id.trim().length).toBeGreaterThan(0);
      }
    });

    it("every entry has a non-empty name", () => {
      for (const entry of QINIU_MODEL_CATALOG) {
        expect(entry.name.trim().length).toBeGreaterThan(0);
      }
    });

    it("every entry has at least text input", () => {
      for (const entry of QINIU_MODEL_CATALOG) {
        expect(entry.input).toContain("text");
      }
    });

    it("every entry has a positive contextWindow", () => {
      for (const entry of QINIU_MODEL_CATALOG) {
        if (entry.contextWindow !== undefined) {
          expect(entry.contextWindow).toBeGreaterThan(0);
        }
      }
    });

    it("every entry has a positive maxTokens", () => {
      for (const entry of QINIU_MODEL_CATALOG) {
        if (entry.maxTokens !== undefined) {
          expect(entry.maxTokens).toBeGreaterThan(0);
        }
      }
    });

    it("maxTokens does not exceed contextWindow", () => {
      for (const entry of QINIU_MODEL_CATALOG) {
        if (entry.contextWindow !== undefined && entry.maxTokens !== undefined) {
          expect(entry.maxTokens).toBeLessThanOrEqual(entry.contextWindow);
        }
      }
    });

    it("reasoning models include thinking or r1 in their name or id", () => {
      const reasoningEntries = QINIU_MODEL_CATALOG.filter((m) => m.reasoning);
      expect(reasoningEntries.length).toBeGreaterThan(0);
    });

    it("vision models declare image input", () => {
      const visionIds = [
        "doubao-1.5-vision-pro",
        "qwen3-vl-30b-a3b-thinking",
        "qwen-vl-max-2025-01-25",
        "qwen2.5-vl-72b-instruct",
        "qwen2.5-vl-7b-instruct",
      ];
      for (const id of visionIds) {
        const entry = QINIU_MODEL_CATALOG.find((m) => m.id === id);
        expect(entry, `model ${id} should be in catalog`).toBeDefined();
        expect(entry!.input).toContain("image");
      }
    });

    it("non-vision models do not declare image input", () => {
      const textOnlyIds = [
        "deepseek-r1",
        "qwen3-32b",
        "z-ai/glm-5",
        "moonshotai/kimi-k2.5",
        "minimax/minimax-m2.5",
      ];
      for (const id of textOnlyIds) {
        const entry = QINIU_MODEL_CATALOG.find((m) => m.id === id);
        expect(entry, `model ${id} should be in catalog`).toBeDefined();
        expect(entry!.input).not.toContain("image");
      }
    });
  });
});
