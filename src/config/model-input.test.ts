import { describe, it, expect } from "vitest";
import {
  resolveAgentModelPrimaryValue,
  resolveAgentModelFallbackValues,
  resolveAgentModelByChatType,
  resolveEffectiveModelForChatType,
} from "./model-input.js";

describe("model-input", () => {
  describe("resolveAgentModelPrimaryValue", () => {
    it("returns string model as-is", () => {
      expect(resolveAgentModelPrimaryValue("anthropic/claude-sonnet-4-6")).toBe(
        "anthropic/claude-sonnet-4-6",
      );
    });

    it("returns primary from object", () => {
      expect(
        resolveAgentModelPrimaryValue({
          primary: "anthropic/claude-sonnet-4-6",
          fallbacks: ["openai/gpt-5"],
        }),
      ).toBe("anthropic/claude-sonnet-4-6");
    });

    it("returns undefined for empty input", () => {
      expect(resolveAgentModelPrimaryValue(undefined)).toBeUndefined();
      expect(resolveAgentModelPrimaryValue(null)).toBeUndefined();
      expect(resolveAgentModelPrimaryValue({})).toBeUndefined();
      expect(resolveAgentModelPrimaryValue({ primary: "" })).toBeUndefined();
    });
  });

  describe("resolveAgentModelFallbackValues", () => {
    it("returns fallbacks array", () => {
      expect(
        resolveAgentModelFallbackValues({
          primary: "anthropic/claude-sonnet-4-6",
          fallbacks: ["openai/gpt-5", "google/gemini-2-flash"],
        }),
      ).toEqual(["openai/gpt-5", "google/gemini-2-flash"]);
    });

    it("returns empty array for non-object", () => {
      expect(resolveAgentModelFallbackValues("string")).toEqual([]);
      expect(resolveAgentModelFallbackValues(undefined)).toEqual([]);
    });
  });

  describe("resolveAgentModelByChatType", () => {
    it("returns direct model for direct chat type", () => {
      const model = {
        primary: "anthropic/claude-sonnet-4-6",
        byChatType: {
          direct: "anthropic/claude-sonnet-4-6",
          group: "minimax/MiniMax-M2.1",
        },
      };
      expect(resolveAgentModelByChatType(model, "direct")).toBe("anthropic/claude-sonnet-4-6");
    });

    it("returns group model for group chat type", () => {
      const model = {
        primary: "anthropic/claude-sonnet-4-6",
        byChatType: {
          direct: "anthropic/claude-sonnet-4-6",
          group: "minimax/MiniMax-M2.1",
        },
      };
      expect(resolveAgentModelByChatType(model, "group")).toBe("minimax/MiniMax-M2.1");
    });

    it("returns channel model for channel chat type", () => {
      const model = {
        primary: "anthropic/claude-sonnet-4-6",
        byChatType: {
          channel: "google/gemini-2-flash",
        },
      };
      expect(resolveAgentModelByChatType(model, "channel")).toBe("google/gemini-2-flash");
    });

    it("returns undefined when no byChatType configured", () => {
      const model = {
        primary: "anthropic/claude-sonnet-4-6",
      };
      expect(resolveAgentModelByChatType(model, "direct")).toBeUndefined();
      expect(resolveAgentModelByChatType(model, "group")).toBeUndefined();
    });

    it("returns undefined for unknown chat type", () => {
      const model = {
        primary: "anthropic/claude-sonnet-4-6",
        byChatType: {
          direct: "anthropic/claude-sonnet-4-6",
        },
      };
      // @ts-expect-error - testing invalid chat type
      expect(resolveAgentModelByChatType(model, "unknown")).toBeUndefined();
    });

    it("returns undefined when model is string", () => {
      expect(resolveAgentModelByChatType("anthropic/claude-sonnet-4-6", "direct")).toBeUndefined();
    });
  });

  describe("resolveEffectiveModelForChatType", () => {
    it("returns chat-type specific model when configured", () => {
      const model = {
        primary: "anthropic/claude-sonnet-4-6",
        byChatType: {
          direct: "anthropic/claude-opus-4-6",
          group: "minimax/MiniMax-M2.1",
        },
      };
      expect(resolveEffectiveModelForChatType(model, "direct")).toBe("anthropic/claude-opus-4-6");
      expect(resolveEffectiveModelForChatType(model, "group")).toBe("minimax/MiniMax-M2.1");
    });

    it("falls back to primary when chat type not configured", () => {
      const model = {
        primary: "anthropic/claude-sonnet-4-6",
        byChatType: {
          direct: "anthropic/claude-opus-4-6",
        },
      };
      expect(resolveEffectiveModelForChatType(model, "group")).toBe("anthropic/claude-sonnet-4-6");
    });

    it("returns primary when no chat type specified", () => {
      const model = {
        primary: "anthropic/claude-sonnet-4-6",
        byChatType: {
          direct: "anthropic/claude-opus-4-6",
        },
      };
      expect(resolveEffectiveModelForChatType(model, undefined)).toBe("anthropic/claude-sonnet-4-6");
    });

    it("returns string model as-is", () => {
      expect(resolveEffectiveModelForChatType("anthropic/claude-sonnet-4-6", "direct")).toBe(
        "anthropic/claude-sonnet-4-6",
      );
    });

    it("returns undefined for empty model", () => {
      expect(resolveEffectiveModelForChatType(undefined, "direct")).toBeUndefined();
      expect(resolveEffectiveModelForChatType(null, "group")).toBeUndefined();
    });
  });
});
