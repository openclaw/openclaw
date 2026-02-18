import { describe, expect, it } from "vitest";
import { HealthTracker } from "../health-tracker.js";
import { ModelSelector } from "../model-selector.js";
import { ModelTier, TaskType, type RoutingConfig } from "../types.js";

function makeConfig(
  overrides: Partial<RoutingConfig> = {},
  matrixOverrides: Partial<Record<TaskType, Partial<Record<ModelTier, string>>>> = {},
): RoutingConfig {
  return {
    default_task_type: TaskType.FALLBACK,
    cooldown_seconds: 30,
    antiflap_enabled: false,
    triggers: {},
    deny_list: [],
    ha_matrix: {
      [TaskType.CODE_EDIT]: {
        [ModelTier.TIER1]: "model-a",
        [ModelTier.TIER2]: "model-b",
        [ModelTier.TIER3]: "model-c",
      },
      [TaskType.CODE_REVIEW]: {
        [ModelTier.TIER1]: "review-1",
        [ModelTier.TIER2]: "review-2",
      },
      [TaskType.FALLBACK]: {
        [ModelTier.TIER1]: "fallback-1",
        [ModelTier.TIER2]: "fallback-2",
      },
      ...matrixOverrides,
    },
    ...overrides,
  };
}

describe("ModelSelector (no HealthTracker)", () => {
  it("resolves all tiers in order for code_edit", () => {
    const selector = new ModelSelector();
    const config = makeConfig();
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    expect(models).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("resolves code_review with 2 tiers", () => {
    const selector = new ModelSelector();
    const config = makeConfig();
    const models = selector.resolveModels(TaskType.CODE_REVIEW, config);
    expect(models).toEqual(["review-1", "review-2"]);
  });

  it("resolves fallback task type", () => {
    const selector = new ModelSelector();
    const config = makeConfig();
    const models = selector.resolveModels(TaskType.FALLBACK, config);
    expect(models).toEqual(["fallback-1", "fallback-2"]);
  });

  it("falls back to default_task_type matrix when taskType has no matrix", () => {
    const selector = new ModelSelector();
    const config = makeConfig(); // CODE_REFACTOR has no matrix entry
    const models = selector.resolveModels(TaskType.CODE_REFACTOR, config);
    // Should fall back to FALLBACK (default_task_type)
    expect(models).toEqual(["fallback-1", "fallback-2"]);
  });

  it("returns empty array when neither taskType nor default has a matrix", () => {
    const selector = new ModelSelector();
    const config: RoutingConfig = {
      default_task_type: TaskType.CODE_EDIT,
      cooldown_seconds: 30,
      antiflap_enabled: false,
      triggers: {},
      deny_list: [],
      ha_matrix: {}, // empty
    };
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    expect(models).toEqual([]);
  });

  it("skips missing tiers (sparse matrix)", () => {
    const selector = new ModelSelector();
    const config = makeConfig(
      {},
      {
        [TaskType.CODE_EDIT]: {
          [ModelTier.TIER1]: "only-tier1",
          // TIER2 and TIER3 absent
        },
      },
    );
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    expect(models).toEqual(["only-tier1"]);
  });
});

describe("ModelSelector (with HealthTracker)", () => {
  function makeHealthConfig() {
    return {
      enabled: true,
      window_size: 10,
      threshold: 0.5,
      cooldown_ms: 60_000,
    };
  }

  it("includes all models when all are healthy", () => {
    const tracker = new HealthTracker(10);
    const selector = new ModelSelector(tracker);
    const config = makeConfig({ health: makeHealthConfig() });

    // All models start at score 1.0 (no data = healthy)
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    expect(models).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("skips unhealthy tier1 model, returns tier2 and tier3", () => {
    const tracker = new HealthTracker(10);
    // 7 failures × 0.3/10 = 0.21 penalty → score = 0.79 < 0.8 (unhealthy)
    const config = makeConfig({
      health: { ...makeHealthConfig(), threshold: 0.8 },
    });

    for (let i = 0; i < 7; i++) {
      tracker.recordResult("model-a", {
        timestamp: Date.now(),
        success: false,
        latencyMs: 100,
        error: "error",
      });
    }

    const selector = new ModelSelector(tracker);
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    expect(models).not.toContain("model-a");
    expect(models).toContain("model-b");
    expect(models).toContain("model-c");
  });

  it("skips multiple unhealthy tiers", () => {
    const tracker = new HealthTracker(10);
    const config = makeConfig({
      health: { ...makeHealthConfig(), threshold: 0.8 },
    });

    // Make model-a and model-b unhealthy (7 failures each → score=0.79 < 0.8)
    for (let i = 0; i < 7; i++) {
      tracker.recordResult("model-a", {
        timestamp: Date.now(),
        success: false,
        latencyMs: 100,
        error: "error",
      });
      tracker.recordResult("model-b", {
        timestamp: Date.now(),
        success: false,
        latencyMs: 100,
        error: "error",
      });
    }

    const selector = new ModelSelector(tracker);
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    expect(models).not.toContain("model-a");
    expect(models).not.toContain("model-b");
    expect(models).toContain("model-c");
  });

  it("returns full unfiltered list when all tiers are unhealthy (fallback safety)", () => {
    const tracker = new HealthTracker(10);
    const config = makeConfig({
      health: { ...makeHealthConfig(), threshold: 0.8 },
    });

    // Make all models unhealthy (7 failures each)
    for (const model of ["model-a", "model-b", "model-c"]) {
      for (let i = 0; i < 7; i++) {
        tracker.recordResult(model, {
          timestamp: Date.now(),
          success: false,
          latencyMs: 100,
          error: "error",
        });
      }
    }

    const selector = new ModelSelector(tracker);
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);

    // Fallback: should return original list (all 3 models)
    expect(models).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("does not filter when health.enabled is false", () => {
    const tracker = new HealthTracker(10);
    const config = makeConfig({
      health: { enabled: false, window_size: 10, threshold: 0.8, cooldown_ms: 60_000 },
    });

    // Make all models "unhealthy"
    for (const model of ["model-a", "model-b", "model-c"]) {
      for (let i = 0; i < 7; i++) {
        tracker.recordResult(model, {
          timestamp: Date.now(),
          success: false,
          latencyMs: 100,
          error: "error",
        });
      }
    }

    const selector = new ModelSelector(tracker);
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    // All 3 returned because enabled=false means no filtering
    expect(models).toEqual(["model-a", "model-b", "model-c"]);
  });
});

describe("ModelSelector — 24 TaskType routing", () => {
  const selector = new ModelSelector();

  const allTaskTypes = Object.values(TaskType);

  it("covers all 24 task types in the enum", () => {
    expect(allTaskTypes).toHaveLength(24);
  });

  it("resolves code_edit to correct models", () => {
    const config = makeConfig();
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    expect(models).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("resolves code_review to correct models", () => {
    const config = makeConfig();
    const models = selector.resolveModels(TaskType.CODE_REVIEW, config);
    expect(models).toEqual(["review-1", "review-2"]);
  });

  it("resolves fallback to correct models", () => {
    const config = makeConfig();
    const models = selector.resolveModels(TaskType.FALLBACK, config);
    expect(models).toEqual(["fallback-1", "fallback-2"]);
  });

  it("all 24 task types resolve without throwing", () => {
    const config = makeConfig();
    for (const taskType of allTaskTypes) {
      expect(() => selector.resolveModels(taskType, config)).not.toThrow();
    }
  });

  it("task types without matrix fall back to default_task_type", () => {
    const config = makeConfig();
    const noMatrixTypes = allTaskTypes.filter(
      (t) => t !== TaskType.CODE_EDIT && t !== TaskType.CODE_REVIEW && t !== TaskType.FALLBACK,
    );
    for (const taskType of noMatrixTypes) {
      const models = selector.resolveModels(taskType, config);
      // Should fall back to FALLBACK matrix
      expect(models).toEqual(["fallback-1", "fallback-2"]);
    }
  });

  it("each task type can have its own matrix entry", () => {
    const fullMatrix: Partial<Record<TaskType, Partial<Record<ModelTier, string>>>> = {};
    for (const t of allTaskTypes) {
      fullMatrix[t] = { [ModelTier.TIER1]: `${t}-model` };
    }
    const config: RoutingConfig = {
      default_task_type: TaskType.FALLBACK,
      cooldown_seconds: 30,
      antiflap_enabled: false,
      triggers: {},
      deny_list: [],
      ha_matrix: fullMatrix,
    };
    for (const t of allTaskTypes) {
      const models = selector.resolveModels(t, config);
      expect(models).toEqual([`${t}-model`]);
    }
  });
});
