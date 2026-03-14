import { describe, it, expect, vi } from "vitest";
import {
  parseSessionConfig,
  createWorkflowCronJob,
  estimateTokenSavings,
  validateWorkflowChain,
  logTokenTrackingSummary,
  type WorkflowChainStep,
  type SessionConfig,
} from "./server-cron.js";
import type { CronSchedule } from "../cron/types.js";

describe("parseSessionConfig", () => {
  it("should parse string shorthand config", () => {
    expect(parseSessionConfig("isolated:minimal")).toEqual({
      target: "isolated",
      contextMode: "minimal",
    });

    expect(parseSessionConfig("reuse:full")).toEqual({
      target: "reuse",
      contextMode: "full",
    });

    expect(parseSessionConfig("main")).toEqual({
      target: "main",
      contextMode: "minimal", // default
    });
  });

  it("should parse object config", () => {
    const config: SessionConfig = {
      target: "isolated",
      contextMode: "minimal",
      model: "test/model",
      maxTokens: 1000,
      thinking: "on",
    };

    expect(parseSessionConfig(config)).toEqual(config);
  });

  it("should merge with default config", () => {
    const defaultConfig: SessionConfig = {
      target: "reuse",
      contextMode: "full",
    };

    const result = parseSessionConfig("isolated:minimal", defaultConfig);
    expect(result.target).toBe("isolated");
    expect(result.contextMode).toBe("minimal");
  });

  it("should return default config for invalid input", () => {
    const defaultConfig: SessionConfig = {
      target: "isolated",
      contextMode: "minimal",
    };

    expect(parseSessionConfig(null, defaultConfig)).toEqual(defaultConfig);
    expect(parseSessionConfig(undefined, defaultConfig)).toEqual(defaultConfig);
    expect(parseSessionConfig({}, defaultConfig)).toEqual(defaultConfig);
  });
});

describe("createWorkflowCronJob", () => {
  it("should create a workflow cron job", () => {
    const schedule: CronSchedule = {
      kind: "every",
      everyMs: 3600000, // 1 hour
    };

    const steps: WorkflowChainStep[] = [
      {
        nodeId: "step1",
        actionType: "fetch",
        label: "Fetch data",
      },
      {
        nodeId: "step2",
        actionType: "process",
        label: "Process data",
      },
    ];

    const job = createWorkflowCronJob(
      "test-workflow",
      "Test Workflow",
      schedule,
      steps,
      {
        enabled: true,
        description: "Test workflow",
      }
    );

    expect(job.id).toBe("test-workflow");
    expect(job.name).toBe("Test Workflow");
    expect(job.workflowType).toBe("chain");
    expect(job.workflowChain.length).toBe(2);
    expect(job.enabled).toBe(true);
    expect(job.description).toBe("Test workflow");
  });

  it("should apply default session config to workflow", () => {
    const schedule: CronSchedule = { kind: "cron", expr: "0 * * * *" };
    const steps: WorkflowChainStep[] = [
      { nodeId: "step1", actionType: "test", label: "Test" },
    ];

    const defaultSessionConfig: SessionConfig = {
      target: "isolated",
      contextMode: "minimal",
      model: "test/model",
    };

    const job = createWorkflowCronJob("test", "Test", schedule, steps, {
      defaultSessionConfig,
    });

    expect(job.defaultSessionConfig).toEqual(defaultSessionConfig);
  });
});

describe("estimateTokenSavings", () => {
  it("should calculate token savings correctly", () => {
    const savings = estimateTokenSavings(10, 10000, 750);

    expect(savings.fullContextTotal).toBe(100000);
    expect(savings.minimalContextTotal).toBe(7500);
    expect(savings.tokensSaved).toBe(92500);
    expect(savings.percentageSaved).toBe(92.5);
  });

  it("should use default values when not provided", () => {
    const savings = estimateTokenSavings(5);

    expect(savings.fullContextTotal).toBe(50000);
    expect(savings.minimalContextTotal).toBe(3750);
    expect(savings.percentageSaved).toBe(92.5);
  });

  it("should show 90-96% savings range", () => {
    // Best case: 500 tokens minimal vs 10000 full
    const bestCase = estimateTokenSavings(1, 10000, 500);
    expect(bestCase.percentageSaved).toBe(95);

    // Worst case: 1000 tokens minimal vs 8000 full
    const worstCase = estimateTokenSavings(1, 8000, 1000);
    expect(worstCase.percentageSaved).toBe(87.5);
  });
});

describe("validateWorkflowChain", () => {
  it("should validate correct workflow chain", () => {
    const steps: WorkflowChainStep[] = [
      { nodeId: "step1", actionType: "fetch", label: "Fetch" },
      { nodeId: "step2", actionType: "process", label: "Process" },
      { nodeId: "step3", actionType: "deliver", label: "Deliver" },
    ];

    const result = validateWorkflowChain(steps);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it("should reject empty chain", () => {
    const result = validateWorkflowChain([]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Workflow chain cannot be empty");
  });

  it("should reject steps with missing nodeId", () => {
    const steps: WorkflowChainStep[] = [
      { nodeId: "", actionType: "test", label: "Test" },
    ];

    const result = validateWorkflowChain(steps);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("nodeId is required"))).toBe(true);
  });

  it("should reject duplicate nodeIds", () => {
    const steps: WorkflowChainStep[] = [
      { nodeId: "step1", actionType: "test", label: "Test 1" },
      { nodeId: "step1", actionType: "test", label: "Test 2" },
    ];

    const result = validateWorkflowChain(steps);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("duplicate nodeId"))).toBe(true);
  });

  it("should reject steps with missing actionType", () => {
    const steps: WorkflowChainStep[] = [
      { nodeId: "step1", actionType: "", label: "Test" },
    ];

    const result = validateWorkflowChain(steps);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("actionType is required"))).toBe(true);
  });

  it("should reject steps with missing label", () => {
    const steps: WorkflowChainStep[] = [
      { nodeId: "step1", actionType: "test", label: "" },
    ];

    const result = validateWorkflowChain(steps);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("label is required"))).toBe(true);
  });

  it("should validate session config", () => {
    const steps: WorkflowChainStep[] = [
      {
        nodeId: "step1",
        actionType: "test",
        label: "Test",
        sessionConfig: {
          target: "invalid" as any,
          contextMode: "minimal",
        },
      },
    ];

    const result = validateWorkflowChain(steps);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("invalid session target"))).toBe(true);
  });

  it("should reject invalid maxTokens", () => {
    const steps: WorkflowChainStep[] = [
      {
        nodeId: "step1",
        actionType: "test",
        label: "Test",
        sessionConfig: {
          target: "isolated",
          contextMode: "minimal",
          maxTokens: -100,
        },
      },
    ];

    const result = validateWorkflowChain(steps);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("maxTokens must be positive"))).toBe(true);
  });

  it("should reject invalid thinking value", () => {
    const steps: WorkflowChainStep[] = [
      {
        nodeId: "step1",
        actionType: "test",
        label: "Test",
        sessionConfig: {
          target: "isolated",
          contextMode: "minimal",
          thinking: "maybe" as any,
        },
      },
    ];

    const result = validateWorkflowChain(steps);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("thinking must be"))).toBe(true);
  });
});

describe("logTokenTrackingSummary", () => {
  it("should handle token tracking summary", () => {
    const tracking = {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      stepBreakdown: {
        step1: { inputTokens: 500, outputTokens: 250, totalTokens: 750 },
        step2: { inputTokens: 500, outputTokens: 250, totalTokens: 750 },
      },
    };

    // This should not throw
    expect(() => logTokenTrackingSummary("test-workflow", tracking)).not.toThrow();
  });
});

describe("Integration: Workflow with session configs", () => {
  it("should create workflow with mixed session configs", () => {
    const schedule: CronSchedule = { kind: "cron", expr: "0 * * * *" };
    
    const steps: WorkflowChainStep[] = [
      {
        nodeId: "fetch",
        actionType: "fetch",
        label: "Fetch data",
        sessionConfig: { target: "isolated", contextMode: "minimal" },
      },
      {
        nodeId: "analyze",
        actionType: "analyze",
        label: "Analyze data",
        sessionConfig: { target: "reuse", contextMode: "full" },
      },
      {
        nodeId: "report",
        actionType: "report",
        label: "Generate report",
        sessionConfig: { target: "main", contextMode: "custom" },
      },
    ];

    const job = createWorkflowCronJob("mixed-workflow", "Mixed Workflow", schedule, steps);
    
    expect(job.workflowChain.length).toBe(3);
    expect(job.workflowChain[0].sessionConfig?.target).toBe("isolated");
    expect(job.workflowChain[1].sessionConfig?.target).toBe("reuse");
    expect(job.workflowChain[2].sessionConfig?.target).toBe("main");
  });
});
