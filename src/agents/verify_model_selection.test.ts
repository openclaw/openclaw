import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../config/config";
import type { ModelCatalogEntry } from "./model-catalog";
import {
  initAutoModelSelection,
  resetAutoModelSelection,
  computeAutoSelections,
} from "./model-auto-select";
import { resolveDefaultModelForAgent, resolveCodingModelForAgent } from "./model-selection";
import { resolveImplicitProviders } from "./models-config.providers";

// Mock catalog with cost/recency variations (uses current-gen models)
const MOCK_CATALOG: ModelCatalogEntry[] = [
  {
    id: "gpt-5",
    name: "GPT-5",
    provider: "openai",
    reasoning: true,
    input: ["text", "image"],
    // Expensive, New
    contextWindow: 128000,
  },
  {
    id: "gpt-5-nano",
    name: "GPT-5 Nano",
    provider: "openai",
    reasoning: false,
    input: ["text"],
    // Cheap, New
    contextWindow: 128000,
  },
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    reasoning: true,
    input: ["text", "image"],
    // Moderate, New
    contextWindow: 200000,
  },
  {
    id: "legacy-model",
    name: "Legacy Model",
    provider: "openai",
    reasoning: false,
    input: ["text"],
    // Expensive, Old
    contextWindow: 4096,
  },
];

// Mock capabilities to align with catalog
vi.mock("./model-capabilities", () => ({
  getModelCapabilitiesFromCatalog: (entry: ModelCatalogEntry) => {
    if (entry.id === "gpt-5-nano") {
      return { performanceTier: "fast", costTier: "cheap", coding: true, reasoning: false };
    }
    if (entry.id === "gpt-5") {
      return { performanceTier: "powerful", costTier: "expensive", coding: true, reasoning: true };
    }
    if (entry.id === "claude-sonnet-4-5") {
      return { performanceTier: "balanced", costTier: "moderate", coding: true, reasoning: true };
    }
    return { performanceTier: "fast", costTier: "expensive", coding: false };
  },
}));

// Mock auth profiles (no cooldowns)
vi.mock("./auth-profiles", () => ({
  ensureAuthProfileStore: () => ({ profiles: {} }),
  isProfileInCooldown: () => false,
  resolveAuthProfileOrder: () => [],
}));

// Mock cooldowns
vi.mock("./model-fallback", () => ({
  isModelCoolingDown: () => false,
}));

describe("Model Selection Verification", () => {
  beforeEach(() => {
    resetAutoModelSelection();
    process.env.OPENCLAW_DISABLE_MODEL_AUTO_SELECT = "";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Scenario 1: Respects Explicit User Selectors", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/legacy-model" },
          codingModel: { primary: "anthropic/claude-sonnet-4-5" },
        },
      },
      models: { providers: {} },
    };

    // Even if auto-select is initialized, explicit config should win?
    // Actually, `resolveDefaultModelForAgent` step 1 is explicit override (per-agent), step 2 is auto.
    // Spec says: "Check explicit per-agent model override".
    // But here we are setting `agents.defaults.model`, which is global default.
    // Code says:
    // 1. Check explicit per-agent override.
    // 2. Auto-select (if enabled).
    // 3. Fall back to global default (`config.agents.defaults.model`).

    // So if auto-select is enabled, it PRECEDES global default?
    // Let's verify this behavior. The user asked "verifique se o sistema esta usando os dois modelos setados nos seletores com padrao".
    // If "selectors" write to `agents.defaults.model`, and auto-select is ON, then auto-select might override user default?
    // Wait, `resolveDefaultModelForAgent` logic:
    // 1. `resolveAgentModelPrimary(cfg, agentId)` -> looks at `agents[id].model`.
    // 2. `autoSelected = getAutoSelectedModel(role)` -> looks at `cachedSelections`.
    // 3. `resolveConfiguredModelRef` -> looks at `agents.defaults.model`.

    // If auto-select is ON (default), it seems to override `agents.defaults.model`.
    // BUT `initAutoModelSelection` is what populates the cache.
    // Validation: Does the system disable auto-select when user selects specific models in UI?
    // Or is "Auto" a specific choice in the UI?

    // If the user selects a specific model in the UI, it likely sets `agents.defaults.model`.
    // If they select "Auto", it likely enables the auto-selector logic (or leaves config empty?).

    // Let's assume for this test that we want to verify:
    // - If explicit agent config is present, it wins.
    // - If NO agent config, but GLOBAL default is present... does Auto win?
    // Lines 235-243 in model-selection.ts:
    // const disableAutoSelect = isTruthyEnvValue(process.env.OPENCLAW_DISABLE_MODEL_AUTO_SELECT);
    // if (!disableAutoSelect && params.agentId) { ... return autoSelected ... }

    // This implies that if I ask for a specific agent's model, and auto-select is ON, I get the auto model, ignoring `agents.defaults.model`.
    // This seems to contradict "using the two models set in the selectors as default".
    // UNLESS the "selectors" in the UI set `OPENCLAW_DISABLE_MODEL_AUTO_SELECT`?
    // OR unless "selectors" update `agents.defaults.model` AND `agents[agent].model`?

    // However, `resolveConfiguredModelRef` is the fallback (step 3).

    // Let's verify what happens when we simply call it.

    initAutoModelSelection(MOCK_CATALOG, undefined, config);

    // Verify default model (Chat) uses "model" selector
    const defaultRef = resolveDefaultModelForAgent({ cfg: config });
    expect(defaultRef.provider).toBe("openai");
    expect(defaultRef.model).toBe("legacy-model");

    // Verify coding model (Code) uses "codingModel" selector
    const codingRef = resolveCodingModelForAgent({ cfg: config });
    expect(codingRef.provider).toBe("anthropic");
    expect(codingRef.model).toBe("claude-sonnet-4-5");
  });

  it("Scenario 2: Auto Mode Selects Best Models", () => {
    const config: OpenClawConfig = {
      agents: { defaults: {} },
      models: { providers: {} },
    };

    // Initialize auto-selection
    initAutoModelSelection(MOCK_CATALOG, undefined, config);

    // Worker role (cheap/fast) should get gpt-5-nano
    // Orchestrator role (balanced/expensive) should get claude-sonnet-4-5 (balanced) or gpt-5 (expensive)
    // rankModelsForRole prefers CHEAPEST that meets requirements.
    // Orchestrator requires "coding" + "reasoning", min "balanced".
    // gpt-5-nano: fast (fails balanced?), reasoning=false (fails).
    // claude-sonnet-4-5: balanced (pass), coding=true, reasoning=true. Cost: moderate.
    // gpt-5: powerful (pass), coding=true, reasoning=true. Cost: expensive.

    // So Orchestrator should pick Claude Sonnet 4.5 (moderate < expensive).

    const selections = computeAutoSelections(MOCK_CATALOG, undefined, config);
    const worker = selections.get("worker");
    const orchestrator = selections.get("orchestrator");

    expect(worker?.model).toBe("gpt-5-nano");
    // claude-sonnet-4-5 (moderate) is cheaper than gpt-5 (expensive).
    expect(orchestrator?.model).toBe("claude-sonnet-4-5");
  });

  it("Scenario 3: Implicit Providers are Resolved", async () => {
    // Mock environment variables
    process.env.GROQ_API_KEY = "gsk_fake_key";
    process.env.MISTRAL_API_KEY = "mistral_fake_key";
    process.env.XAI_API_KEY = "xai_fake_key";
    process.env.CEREBRAS_API_KEY = "cerebras_fake_key";
    process.env.OPENROUTER_API_KEY = "sk-or-fake-key";

    const providers = await resolveImplicitProviders({ agentDir: "/tmp" });

    expect(providers).toBeDefined();
    if (!providers) {
      return;
    }

    // Check Groq
    expect(providers["groq"]).toBeDefined();
    expect(providers["groq"]?.baseUrl).toBe("https://api.groq.com/openai/v1");
    // System returns the ENV VAR NAME for implicit providers found in process.env
    expect(providers["groq"]?.apiKey).toBe("GROQ_API_KEY");

    // Check Mistral
    expect(providers["mistral"]).toBeDefined();
    expect(providers["mistral"]?.baseUrl).toBe("https://api.mistral.ai/v1");
    expect(providers["mistral"]?.apiKey).toBe("MISTRAL_API_KEY");

    // Check xAI
    expect(providers["xai"]).toBeDefined();
    expect(providers["xai"]?.apiKey).toBe("XAI_API_KEY");

    // Check Cerebras
    expect(providers["cerebras"]).toBeDefined();
    expect(providers["cerebras"]?.apiKey).toBe("CEREBRAS_API_KEY");

    // Check OpenRouter
    expect(providers["openrouter"]).toBeDefined();
    expect(providers["openrouter"]?.apiKey).toBe("OPENROUTER_API_KEY");

    // Cleanup
    delete process.env.GROQ_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.CEREBRAS_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });
});
