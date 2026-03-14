import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkflowExecutor, type WorkflowChainStep, type SessionConfig } from "./workflow-executor.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { CliDeps } from "../../cli/deps.js";

// Mock dependencies
const mockConfig: OpenClawConfig = {
  session: {
    store: "~/.openclaw/sessions.json",
  },
  agents: {
    defaults: {
      model: {
        primary: "test/model",
      },
    },
  },
};

const mockDeps: CliDeps = {
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
} as unknown as CliDeps;

describe("WorkflowExecutor", () => {
  let executor: WorkflowExecutor;

  beforeEach(() => {
    executor = new WorkflowExecutor(mockConfig, mockDeps);
  });

  describe("constructor", () => {
    it("should initialize with empty token tracking", () => {
      const tracking = executor.getTokenTracking();
      expect(tracking.inputTokens).toBe(0);
      expect(tracking.outputTokens).toBe(0);
      expect(tracking.totalTokens).toBe(0);
      expect(Object.keys(tracking.stepBreakdown).length).toBe(0);
    });
  });

  describe("buildPrompt", () => {
    it("should build minimal context prompt", () => {
      const step: WorkflowChainStep = {
        nodeId: "step1",
        actionType: "analyze",
        label: "Analyze data",
        prompt: "Analyze the provided data",
      };

      const context = {
        workflowId: "test-workflow",
        timestamp: Date.now(),
        currentStepIndex: 0,
        stepResults: {},
        sharedData: {},
        sessions: new Map<string, string>(),
      };

      const sessionConfig: SessionConfig = {
        target: "isolated",
        contextMode: "minimal",
      };

      // @ts-ignore - accessing private method for testing
      const prompt = executor.buildPrompt(step, context, sessionConfig);

      expect(prompt).toContain("Workflow: test-workflow");
      expect(prompt).toContain("Step: Analyze data (step1)");
      expect(prompt).toContain("Position: 1");
      expect(prompt).toContain("Task: Analyze the provided data");
    });

    it("should include previous step output in minimal context", () => {
      const step: WorkflowChainStep = {
        nodeId: "step2",
        actionType: "process",
        label: "Process results",
        prompt: "Process the results",
      };

      const context = {
        workflowId: "test-workflow",
        timestamp: Date.now(),
        currentStepIndex: 1,
        stepResults: {
          step1: { data: "test data" },
        },
        sharedData: {},
        sessions: new Map<string, string>(),
      };

      const sessionConfig: SessionConfig = {
        target: "isolated",
        contextMode: "minimal",
      };

      // @ts-ignore - accessing private method for testing
      const prompt = executor.buildPrompt(step, context, sessionConfig);

      expect(prompt).toContain("Previous step output");
      expect(prompt).toContain("test data");
    });

    it("should build full context prompt with all previous steps", () => {
      const step: WorkflowChainStep = {
        nodeId: "step3",
        actionType: "summarize",
        label: "Summarize",
        prompt: "Summarize everything",
      };

      const context = {
        workflowId: "test-workflow",
        timestamp: Date.now(),
        currentStepIndex: 2,
        stepResults: {
          step1: { result: "first" },
          step2: { result: "second" },
        },
        sharedData: {},
        sessions: new Map<string, string>(),
      };

      const sessionConfig: SessionConfig = {
        target: "isolated",
        contextMode: "full",
      };

      // @ts-ignore - accessing private method for testing
      const prompt = executor.buildPrompt(step, context, sessionConfig);

      expect(prompt).toContain("Previous steps:");
      expect(prompt).toContain("step1");
      expect(prompt).toContain("step2");
      expect(prompt).toContain("first");
      expect(prompt).toContain("second");
    });
  });

  describe("trackTokenUsage", () => {
    it("should track token usage for a step", () => {
      const usage = {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      };

      // @ts-ignore - accessing private method for testing
      executor.trackTokenUsage("step1", usage);

      const tracking = executor.getTokenTracking();
      expect(tracking.inputTokens).toBe(100);
      expect(tracking.outputTokens).toBe(50);
      expect(tracking.totalTokens).toBe(150);
      expect(tracking.stepBreakdown["step1"]).toEqual(usage);
    });

    it("should accumulate token usage across multiple steps", () => {
      // @ts-ignore
      executor.trackTokenUsage("step1", { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
      // @ts-ignore
      executor.trackTokenUsage("step2", { inputTokens: 200, outputTokens: 100, totalTokens: 300 });

      const tracking = executor.getTokenTracking();
      expect(tracking.inputTokens).toBe(300);
      expect(tracking.outputTokens).toBe(150);
      expect(tracking.totalTokens).toBe(450);
      expect(Object.keys(tracking.stepBreakdown).length).toBe(2);
    });
  });

  describe("resetTokenTracking", () => {
    it("should reset all token tracking to zero", () => {
      // @ts-ignore
      executor.trackTokenUsage("step1", { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
      
      executor.resetTokenTracking();

      const tracking = executor.getTokenTracking();
      expect(tracking.inputTokens).toBe(0);
      expect(tracking.outputTokens).toBe(0);
      expect(tracking.totalTokens).toBe(0);
      expect(Object.keys(tracking.stepBreakdown).length).toBe(0);
    });
  });
});

describe("SessionConfig parsing", () => {
  it("should accept valid session configs", () => {
    const configs: SessionConfig[] = [
      { target: "isolated", contextMode: "minimal" },
      { target: "reuse", contextMode: "full" },
      { target: "main", contextMode: "custom" },
      { target: "isolated", contextMode: "minimal", model: "test/model" },
      { target: "isolated", contextMode: "minimal", maxTokens: 1000 },
      { target: "isolated", contextMode: "minimal", thinking: "on" },
    ];

    configs.forEach((config) => {
      expect(() => config).not.toThrow();
    });
  });
});

describe("WorkflowChainStep validation", () => {
  it("should accept valid workflow steps", () => {
    const steps: WorkflowChainStep[] = [
      {
        nodeId: "step1",
        actionType: "analyze",
        label: "First step",
      },
      {
        nodeId: "step2",
        actionType: "process",
        label: "Second step",
        agentId: "test-agent",
        prompt: "Do something",
      },
      {
        nodeId: "step3",
        actionType: "summarize",
        label: "Third step",
        sessionConfig: {
          target: "isolated",
          contextMode: "minimal",
        },
      },
    ];

    expect(steps.length).toBe(3);
    expect(steps[0].nodeId).toBe("step1");
    expect(steps[1].prompt).toBe("Do something");
    expect(steps[2].sessionConfig?.target).toBe("isolated");
  });
});
