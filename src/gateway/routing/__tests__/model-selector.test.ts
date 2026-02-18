import { describe, expect, it } from "vitest";
import { BudgetTracker } from "../budget-tracker.js";
import { HealthTracker } from "../health-tracker.js";
import { type AgentListEntry, ModelSelector } from "../model-selector.js";
import { ModelTier, TaskType, type BudgetConfig, type RoutingConfig } from "../types.js";

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

// ── Budget-aware routing tests (cases 16–22) ─────────────────────────────────

function makeBudgetConfig(overrides: Partial<BudgetConfig> = {}): BudgetConfig {
  return {
    enabled: true,
    daily_budget_usd: 10,
    daily_token_limit: 500_000,
    warning_threshold: 0.8,
    critical_action: "degrade",
    ...overrides,
  };
}

describe("ModelSelector — budget-aware routing", () => {
  // Standard 3-tier matrix for budget tests
  const threeConfig = makeConfig();

  // 16. No budgetTracker → original behaviour unchanged
  it("16. no budgetTracker → behaves as before (all tiers returned)", () => {
    const selector = new ModelSelector();
    const models = selector.resolveModels(TaskType.CODE_EDIT, threeConfig);
    expect(models).toEqual(["model-a", "model-b", "model-c"]);
  });

  // 17. budget normal → starts at tier1
  it("17. budget normal → starts at TIER1, all tiers returned", () => {
    const tracker = new BudgetTracker(makeBudgetConfig());
    // no usage → normal
    const selector = new ModelSelector(undefined, tracker);
    const config = makeConfig({ budget: makeBudgetConfig() });
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    expect(models).toEqual(["model-a", "model-b", "model-c"]);
  });

  // 18. budget warning → skip tier1
  it("18. budget warning → skips TIER1, returns TIER2 + TIER3", () => {
    const budgetCfg = makeBudgetConfig({ daily_budget_usd: 10 });
    const tracker = new BudgetTracker(budgetCfg);
    // 85% → warning
    tracker.recordUsage({
      model: "x",
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 8.5,
      timestamp: Date.now(),
    });

    const selector = new ModelSelector(undefined, tracker);
    const config = makeConfig({ budget: budgetCfg });
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    expect(models).not.toContain("model-a");
    expect(models).toContain("model-b");
    expect(models).toContain("model-c");
  });

  // 19. budget critical + degrade → only tier3
  it("19. budget critical + degrade → only TIER3 returned", () => {
    const budgetCfg = makeBudgetConfig({ daily_budget_usd: 10, critical_action: "degrade" });
    const tracker = new BudgetTracker(budgetCfg);
    tracker.recordUsage({
      model: "x",
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 11.0,
      timestamp: Date.now(),
    });

    const selector = new ModelSelector(undefined, tracker);
    const config = makeConfig({ budget: budgetCfg });
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    expect(models).toEqual(["model-c"]);
  });

  // 20. budget critical + degrade + fallback_model → returns fallback
  it("20. budget critical + degrade + fallback_model → returns fallback when tier3 absent", () => {
    const budgetCfg = makeBudgetConfig({
      daily_budget_usd: 10,
      critical_action: "degrade",
      fallback_model: "free-model",
    });
    const tracker = new BudgetTracker(budgetCfg);
    tracker.recordUsage({
      model: "x",
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 11.0,
      timestamp: Date.now(),
    });

    const selector = new ModelSelector(undefined, tracker);
    // Config with no TIER3 entry so the tier3 slot is empty → falls to fallback
    const config = makeConfig(
      { budget: budgetCfg },
      {
        [TaskType.CODE_EDIT]: {
          [ModelTier.TIER1]: "model-a",
          [ModelTier.TIER2]: "model-b",
          // no TIER3
        },
      },
    );
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    expect(models).toEqual(["free-model"]);
  });

  // 21. budget critical + block → returns []
  it("21. budget critical + block → returns empty array", () => {
    const budgetCfg = makeBudgetConfig({ daily_budget_usd: 10, critical_action: "block" });
    const tracker = new BudgetTracker(budgetCfg);
    tracker.recordUsage({
      model: "x",
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 11.0,
      timestamp: Date.now(),
    });

    const selector = new ModelSelector(undefined, tracker);
    const config = makeConfig({ budget: budgetCfg });
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    expect(models).toEqual([]);
  });

  // 22. budget warning + tier2 unhealthy → falls through to tier3
  it("22. budget warning + tier2 unhealthy → skips to TIER3", () => {
    const budgetCfg = makeBudgetConfig({ daily_budget_usd: 10 });
    const budgetTracker = new BudgetTracker(budgetCfg);
    budgetTracker.recordUsage({
      model: "x",
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 8.5,
      timestamp: Date.now(),
    }); // warning

    const healthTracker = new HealthTracker(10);
    // make model-b (tier2) unhealthy
    for (let i = 0; i < 7; i++) {
      healthTracker.recordResult("model-b", {
        timestamp: Date.now(),
        success: false,
        latencyMs: 100,
        error: "error",
      });
    }

    const selector = new ModelSelector(healthTracker, budgetTracker);
    const config = makeConfig({
      budget: budgetCfg,
      health: { enabled: true, window_size: 10, threshold: 0.8, cooldown_ms: 60_000 },
    });
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    expect(models).not.toContain("model-a"); // skipped by budget
    expect(models).not.toContain("model-b"); // skipped by health
    expect(models).toContain("model-c");
  });
});

// ── Agent-list-based routing tests ───────────────────────────────────────────

/** Minimal config without ha_matrix (new architecture). */
function makeConfigNoMatrix(overrides: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    default_task_type: TaskType.FALLBACK,
    cooldown_seconds: 30,
    antiflap_enabled: false,
    triggers: {},
    deny_list: [],
    // ha_matrix intentionally omitted
    ...overrides,
  };
}

describe("ModelSelector — agent-list-based routing", () => {
  const baseAgentList: AgentListEntry[] = [
    {
      id: "coder",
      model: "anthropic/claude-sonnet-4-6",
      tasks: ["code_edit", "code_debug", "code_refactor", "test_write", "git_ops"],
      priority: 1,
    },
    {
      id: "writer",
      model: "minimax/MiniMax-M2.5",
      tasks: ["doc_write", "translation", "memory_update"],
      priority: 1,
    },
    {
      id: "thinker",
      model: "anthropic/claude-opus-4-6",
      tasks: ["planning", "reasoning", "fallback"],
      priority: 1,
    },
  ];

  it("A1. resolves code_edit to coder model", () => {
    const selector = new ModelSelector();
    const config = makeConfigNoMatrix();
    const models = selector.resolveModels(TaskType.CODE_EDIT, config, baseAgentList);
    expect(models).toEqual(["anthropic/claude-sonnet-4-6"]);
  });

  it("A2. resolves doc_write to writer model", () => {
    const selector = new ModelSelector();
    const config = makeConfigNoMatrix();
    const models = selector.resolveModels(TaskType.DOC_WRITE, config, baseAgentList);
    expect(models).toEqual(["minimax/MiniMax-M2.5"]);
  });

  it("A3. resolves planning to thinker model", () => {
    const selector = new ModelSelector();
    const config = makeConfigNoMatrix();
    const models = selector.resolveModels(TaskType.PLANNING, config, baseAgentList);
    expect(models).toEqual(["anthropic/claude-opus-4-6"]);
  });

  it("A4. resolves fallback to thinker model", () => {
    const selector = new ModelSelector();
    const config = makeConfigNoMatrix();
    const models = selector.resolveModels(TaskType.FALLBACK, config, baseAgentList);
    expect(models).toEqual(["anthropic/claude-opus-4-6"]);
  });

  it("A5. multiple agents for same task — sorted by priority (lower first)", () => {
    const agentList: AgentListEntry[] = [
      { id: "agent-slow", model: "model-slow", tasks: ["code_edit"], priority: 5 },
      { id: "agent-fast", model: "model-fast", tasks: ["code_edit"], priority: 2 },
      { id: "agent-mid", model: "model-mid", tasks: ["code_edit"], priority: 3 },
    ];
    const selector = new ModelSelector();
    const config = makeConfigNoMatrix();
    const models = selector.resolveModels(TaskType.CODE_EDIT, config, agentList);
    expect(models).toEqual(["model-fast", "model-mid", "model-slow"]);
  });

  it("A6. same priority — preserves original list order", () => {
    const agentList: AgentListEntry[] = [
      { id: "agent-a", model: "model-a", tasks: ["code_edit"], priority: 1 },
      { id: "agent-b", model: "model-b", tasks: ["code_edit"], priority: 1 },
      { id: "agent-c", model: "model-c", tasks: ["code_edit"], priority: 1 },
    ];
    const selector = new ModelSelector();
    const config = makeConfigNoMatrix();
    const models = selector.resolveModels(TaskType.CODE_EDIT, config, agentList);
    expect(models).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("A7. default priority (10) when unset — lower explicit priority wins", () => {
    const agentList: AgentListEntry[] = [
      { id: "agent-default", model: "model-default", tasks: ["code_edit"] }, // priority=10
      { id: "agent-explicit", model: "model-explicit", tasks: ["code_edit"], priority: 2 },
    ];
    const selector = new ModelSelector();
    const config = makeConfigNoMatrix();
    const models = selector.resolveModels(TaskType.CODE_EDIT, config, agentList);
    expect(models[0]).toBe("model-explicit");
    expect(models[1]).toBe("model-default");
  });

  it("A8. no agents declare taskType — falls back to ha_matrix", () => {
    const agentList: AgentListEntry[] = [
      { id: "writer", model: "minimax/MiniMax-M2.5", tasks: ["doc_write"], priority: 1 },
    ];
    // config has ha_matrix for code_edit
    const config: RoutingConfig = {
      default_task_type: TaskType.FALLBACK,
      cooldown_seconds: 30,
      antiflap_enabled: false,
      triggers: {},
      deny_list: [],
      ha_matrix: {
        [TaskType.CODE_EDIT]: {
          [ModelTier.TIER1]: "ha-model-tier1",
          [ModelTier.TIER2]: "ha-model-tier2",
        },
      },
    };
    const selector = new ModelSelector();
    const models = selector.resolveModels(TaskType.CODE_EDIT, config, agentList);
    expect(models).toEqual(["ha-model-tier1", "ha-model-tier2"]);
  });

  it("A9. empty agentList — falls back to ha_matrix", () => {
    const config: RoutingConfig = {
      default_task_type: TaskType.FALLBACK,
      cooldown_seconds: 30,
      antiflap_enabled: false,
      triggers: {},
      deny_list: [],
      ha_matrix: {
        [TaskType.FALLBACK]: { [ModelTier.TIER1]: "fallback-model" },
      },
    };
    const selector = new ModelSelector();
    const models = selector.resolveModels(TaskType.FALLBACK, config, []);
    expect(models).toEqual(["fallback-model"]);
  });

  it("A10. no agentList arg — falls back to ha_matrix", () => {
    const config = makeConfig(); // has ha_matrix
    const selector = new ModelSelector();
    const models = selector.resolveModels(TaskType.CODE_EDIT, config);
    expect(models).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("A11. agent with object model shape — primary + fallbacks both returned", () => {
    const agentList: AgentListEntry[] = [
      {
        id: "coder",
        model: { primary: "openai/gpt-5", fallbacks: ["openai/gpt-4o"] },
        tasks: ["code_edit"],
        priority: 1,
      },
    ];
    const selector = new ModelSelector();
    const config = makeConfigNoMatrix();
    const models = selector.resolveModels(TaskType.CODE_EDIT, config, agentList);
    expect(models).toEqual(["openai/gpt-5", "openai/gpt-4o"]);
  });

  it("A16. multiple agents each with fallbacks — full chain expanded in priority order", () => {
    const agentList: AgentListEntry[] = [
      {
        id: "primary-coder",
        model: { primary: "claude-sonnet", fallbacks: ["claude-haiku"] },
        tasks: ["code_edit"],
        priority: 1,
      },
      {
        id: "backup-coder",
        model: { primary: "gpt-4o", fallbacks: ["gpt-4o-mini"] },
        tasks: ["code_edit"],
        priority: 2,
      },
    ];
    const selector = new ModelSelector();
    const config = makeConfigNoMatrix();
    const models = selector.resolveModels(TaskType.CODE_EDIT, config, agentList);
    // agent1.primary → agent1.fallbacks → agent2.primary → agent2.fallbacks
    expect(models).toEqual(["claude-sonnet", "claude-haiku", "gpt-4o", "gpt-4o-mini"]);
  });

  it("A17. agent with empty fallbacks — only primary returned", () => {
    const agentList: AgentListEntry[] = [
      {
        id: "coder",
        model: { primary: "openai/gpt-5", fallbacks: [] },
        tasks: ["code_edit"],
        priority: 1,
      },
    ];
    const selector = new ModelSelector();
    const config = makeConfigNoMatrix();
    const models = selector.resolveModels(TaskType.CODE_EDIT, config, agentList);
    expect(models).toEqual(["openai/gpt-5"]);
  });

  it("A12. agent with no model field — skipped gracefully", () => {
    const agentList: AgentListEntry[] = [
      { id: "ghost", tasks: ["code_edit"], priority: 1 }, // no model
      { id: "coder", model: "actual-model", tasks: ["code_edit"], priority: 2 },
    ];
    const selector = new ModelSelector();
    const config = makeConfigNoMatrix();
    const models = selector.resolveModels(TaskType.CODE_EDIT, config, agentList);
    expect(models).toEqual(["actual-model"]);
  });

  it("A13. budget block → returns [] even with agent list", () => {
    const budgetCfg = makeBudgetConfig({ critical_action: "block" });
    const budgetTracker = new BudgetTracker(budgetCfg);
    budgetTracker.recordUsage({
      model: "x",
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 11.0,
      timestamp: Date.now(),
    });
    const selector = new ModelSelector(undefined, budgetTracker);
    const config = makeConfigNoMatrix({ budget: budgetCfg });
    const models = selector.resolveModels(TaskType.CODE_EDIT, config, baseAgentList);
    expect(models).toEqual([]);
  });

  it("A14. health filter skips unhealthy agent model", () => {
    const healthTracker = new HealthTracker(10);
    // make coder model unhealthy
    for (let i = 0; i < 7; i++) {
      healthTracker.recordResult("anthropic/claude-sonnet-4-6", {
        timestamp: Date.now(),
        success: false,
        latencyMs: 100,
        error: "error",
      });
    }
    const agentList: AgentListEntry[] = [
      {
        id: "coder",
        model: "anthropic/claude-sonnet-4-6",
        tasks: ["code_edit"],
        priority: 1,
      },
      {
        id: "backup",
        model: "backup-model",
        tasks: ["code_edit"],
        priority: 2,
      },
    ];
    const selector = new ModelSelector(healthTracker);
    const config = makeConfigNoMatrix({
      health: { enabled: true, window_size: 10, threshold: 0.8, cooldown_ms: 60_000 },
    });
    const models = selector.resolveModels(TaskType.CODE_EDIT, config, agentList);
    expect(models).not.toContain("anthropic/claude-sonnet-4-6");
    expect(models).toContain("backup-model");
  });

  it("A15. all agent models unhealthy — safety net returns original list", () => {
    const healthTracker = new HealthTracker(10);
    for (const model of ["model-a", "model-b"]) {
      for (let i = 0; i < 7; i++) {
        healthTracker.recordResult(model, {
          timestamp: Date.now(),
          success: false,
          latencyMs: 100,
          error: "error",
        });
      }
    }
    const agentList: AgentListEntry[] = [
      { id: "a1", model: "model-a", tasks: ["code_edit"], priority: 1 },
      { id: "a2", model: "model-b", tasks: ["code_edit"], priority: 2 },
    ];
    const selector = new ModelSelector(healthTracker);
    const config = makeConfigNoMatrix({
      health: { enabled: true, window_size: 10, threshold: 0.8, cooldown_ms: 60_000 },
    });
    const models = selector.resolveModels(TaskType.CODE_EDIT, config, agentList);
    // Safety net: should return original unfiltered list
    expect(models).toEqual(["model-a", "model-b"]);
  });
});
