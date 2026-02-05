import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveModelForTaskType } from "../agents/model-selection.js";
import { classifyTask } from "../agents/task-classifier.js";

describe("agent task classification integration", () => {
  describe("classifyTask for agent prompts", () => {
    it("classifies coding prompts correctly", () => {
      expect(classifyTask("Write a function to parse JSON in Python")).toBe("coding");
      expect(classifyTask("Fix the bug in the React component")).toBe("coding");
      expect(classifyTask("Implement the API endpoint for user authentication")).toBe("coding");
      expect(classifyTask("Debug this TypeScript error")).toBe("coding");
    });

    it("classifies vision prompts correctly", () => {
      expect(classifyTask("Analyze this screenshot and describe what you see")).toBe("vision");
      expect(classifyTask("What's in this image?")).toBe("vision");
      expect(classifyTask("Look at the UI mockup and suggest improvements")).toBe("vision");
    });

    it("classifies reasoning prompts correctly", () => {
      expect(classifyTask("Analyze the tradeoffs between microservices and monolith")).toBe(
        "reasoning",
      );
      expect(classifyTask("Compare and evaluate these architecture options")).toBe("reasoning");
    });

    it("classifies general prompts correctly", () => {
      expect(classifyTask("Hello, how are you?")).toBe("general");
      expect(classifyTask("Tell me a joke")).toBe("general");
      expect(classifyTask("What's the weather like?")).toBe("general");
    });
  });

  describe("resolveModelForTaskType", () => {
    it("uses codingModel for coding tasks when configured", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-5" },
            codingModel: { primary: "anthropic/claude-opus-4-5" },
          },
        },
      };

      const result = resolveModelForTaskType({ cfg, taskType: "coding" });
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-opus-4-5");
    });

    it("uses imageModel for vision tasks when configured", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-5" },
            imageModel: { primary: "openai/gpt-4o" },
          },
        },
      };

      const result = resolveModelForTaskType({ cfg, taskType: "vision" });
      expect(result.provider).toBe("openai");
      expect(result.model).toBe("gpt-4o");
    });

    it("uses default model for general tasks", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-5" },
            codingModel: { primary: "anthropic/claude-opus-4-5" },
          },
        },
      };

      const result = resolveModelForTaskType({ cfg, taskType: "general" });
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-sonnet-4-5");
    });

    it("falls back to default model when no specialized model is configured", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-5" },
          },
        },
      };

      const codingResult = resolveModelForTaskType({ cfg, taskType: "coding" });
      expect(codingResult.provider).toBe("anthropic");
      expect(codingResult.model).toBe("claude-sonnet-4-5");

      const visionResult = resolveModelForTaskType({ cfg, taskType: "vision" });
      expect(visionResult.provider).toBe("anthropic");
      expect(visionResult.model).toBe("claude-sonnet-4-5");
    });

    it("uses default model for reasoning tasks", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
          },
        },
      };

      const result = resolveModelForTaskType({ cfg, taskType: "reasoning" });
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-opus-4-5");
    });
  });

  describe("integration: task classification determines model selection", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-5" },
          codingModel: { primary: "anthropic/claude-opus-4-5" },
          imageModel: { primary: "openai/gpt-4o" },
        },
      },
    };

    it("selects codingModel for coding prompts", () => {
      const prompt = "Write a Python function to sort a list";
      const taskType = classifyTask(prompt);
      expect(taskType).toBe("coding");

      const model = resolveModelForTaskType({ cfg, taskType });
      expect(model.model).toBe("claude-opus-4-5");
    });

    it("selects imageModel for vision prompts", () => {
      const prompt = "Analyze this screenshot and tell me what you see";
      const taskType = classifyTask(prompt);
      expect(taskType).toBe("vision");

      const model = resolveModelForTaskType({ cfg, taskType });
      expect(model.model).toBe("gpt-4o");
    });

    it("selects default model for general prompts", () => {
      const prompt = "Hello, how can you help me today?";
      const taskType = classifyTask(prompt);
      expect(taskType).toBe("general");

      const model = resolveModelForTaskType({ cfg, taskType });
      expect(model.model).toBe("claude-sonnet-4-5");
    });
  });
});
