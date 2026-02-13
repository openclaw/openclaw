import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveModelForTaskIntent, resolveModelForTaskType } from "../agents/model-selection.js";
import { classifyComplexity, classifyTask } from "../agents/task-classifier.js";

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

  describe("resolveModelForTaskIntent (complexity-aware)", () => {
    it("uses modelByComplexity mapping when enabled", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-5" },
            modelByComplexity: {
              enabled: true,
              trivial: "openai/gpt-5-nano",
              moderate: "openai/gpt-5-mini",
              complex: "anthropic/claude-opus-4-6",
            },
          },
        },
      };

      const prompt = "Summarize this in one line.";
      const taskType = classifyTask(prompt);
      const complexity = classifyComplexity(prompt);
      expect(complexity).toBe("trivial");

      const result = resolveModelForTaskIntent({ cfg, taskType, complexity });
      expect(result.reason).toBe("complexity");
      expect(result.ref.provider).toBe("openai");
      expect(result.ref.model).toBe("gpt-5-nano");
    });

    it("does not let complexity override vision routing", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-5" },
            imageModel: { primary: "openai/gpt-5-mini" },
            modelByComplexity: {
              enabled: true,
              complex: "openai/gpt-5.2",
            },
          },
        },
      };

      const prompt = "Analyze this screenshot [image] and describe what you see";
      const taskType = classifyTask(prompt);
      const complexity = classifyComplexity(prompt);
      expect(taskType).toBe("vision");

      const result = resolveModelForTaskIntent({ cfg, taskType, complexity });
      expect(result.reason).toBe("taskType");
      expect(result.ref.provider).toBe("openai");
      expect(result.ref.model).toBe("gpt-5-mini");
    });

    it("still routes by complexity when autoPickFromPool is disabled (autoPickFromPool only controls pool-based selection)", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-5" },
            modelByComplexity: {
              enabled: true,
              autoPickFromPool: false,
              trivial: "openai/gpt-5-nano",
              moderate: "openai/gpt-5-mini",
              complex: "anthropic/claude-opus-4-6",
            },
          },
        },
      };

      const prompt = "Summarize this quickly.";
      const taskType = classifyTask(prompt);
      const complexity = classifyComplexity(prompt);

      const result = resolveModelForTaskIntent({ cfg, taskType, complexity });
      expect(result.reason).toBe("complexity");
      expect(result.ref.provider).toBe("openai");
      expect(result.ref.model).toBe("gpt-5-nano");
    });

    it("does not let complexity override explicit coding model", () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-5" },
            codingModel: { primary: "openai-codex/gpt-5.1-codex-mini" },
            modelByComplexity: {
              enabled: true,
              autoPickFromPool: true,
              complex: "anthropic/claude-opus-4-6",
            },
          },
        },
      };

      const prompt = "Implement auth, retries, caching, metrics, and tests for this API.";
      const taskType = classifyTask(prompt);
      const complexity = classifyComplexity(prompt);
      expect(taskType).toBe("coding");

      const result = resolveModelForTaskIntent({ cfg, taskType, complexity });
      expect(result.reason).toBe("taskType");
      expect(result.ref.provider).toBe("openai-codex");
      expect(result.ref.model).toBe("gpt-5.1-codex-mini");
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
