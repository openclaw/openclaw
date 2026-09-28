import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentHarnessPolicy } from "../agents/harness/policy.js";
import {
  inferUniqueProviderFromConfiguredModels,
  resolveConfiguredModelPolicyAllow,
} from "../agents/model-selection-shared.js";
import type { SessionEntry } from "../config/sessions.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSkillCollectionReviewRuntimeOverride } from "./skill-collection-review-runtime.js";

function config(): OpenClawConfig {
  return {
    agents: { entries: { main: {}, other: {} } },
    models: {
      providers: {
        openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1", models: [] },
      },
    },
  };
}

function model(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    maxTokens: 4000,
  };
}

function reviewRuntime(cfg: OpenClawConfig, modelId = "gpt-primary", sessionEntry?: SessionEntry) {
  return resolveSkillCollectionReviewRuntimeOverride({
    config: cfg,
    agentId: "main",
    provider: "openai",
    modelId,
    sessionEntry,
  });
}

describe("collection review runtime override", () => {
  beforeEach(() => vi.stubEnv("OPENAI_BASE_URL", ""));
  afterEach(() => vi.unstubAllEnvs());

  it("selects embedded execution for implicit primary and fallback models without changing config", () => {
    const original = config();
    const snapshot = structuredClone(original);
    expect(reviewRuntime(original)).toBe("openclaw");
    expect(reviewRuntime(original, "gpt-fallback")).toBe("openclaw");
    expect(original).toEqual(snapshot);
    expect(
      resolveAgentHarnessPolicy({
        config: original,
        agentId: "main",
        provider: "openai",
        modelId: "gpt-primary",
      }).runtime,
    ).toBe("codex");
  });

  it.each(["codex", "claude-cli", "openclaw"])("preserves explicit provider policy %s", (id) => {
    const original = config();
    original.models!.providers!.openai!.agentRuntime = { id };
    expect(reviewRuntime(original)).toBeUndefined();
  });

  it.each(["gpt-primary", "openai/gpt-primary", "openai/*"])(
    "preserves explicit agent and default model policies at %s",
    (ref) => {
      const original = config();
      original.agents!.defaults = { models: { [ref]: { agentRuntime: { id: "codex" } } } };
      expect(reviewRuntime(original)).toBeUndefined();
      original.agents!.defaults = {};
      original.agents!.entries!.main!.models = { [ref]: { agentRuntime: { id: "codex" } } };
      expect(reviewRuntime(original)).toBeUndefined();
    },
  );

  it.each(["auto", "default"])("supports an authored %s model runtime", (id) => {
    const original = config();
    original.agents!.entries!.main!.models = { "gpt-primary": { agentRuntime: { id } } };
    expect(reviewRuntime(original)).toBe("openclaw");
  });

  it("preserves an explicit provider-catalog model runtime", () => {
    const original = config();
    original.models!.providers!.openai!.models = [
      { ...model("gpt-primary"), agentRuntime: { id: "codex" } },
    ];
    expect(reviewRuntime(original)).toBeUndefined();
  });

  it.each([
    { agentRuntimeOverride: "codex" },
    { agentHarnessId: "codex", modelSelectionLocked: true },
    { agentRuntimeOverride: "openclaw" },
  ])("honors session runtime ownership %j", (fields) => {
    const entry: SessionEntry = { sessionId: "review-session", updatedAt: 1, ...fields };
    expect(reviewRuntime(config(), "gpt-primary", entry)).toBe(
      fields.agentRuntimeOverride ?? fields.agentHarnessId,
    );
  });

  it("does not treat an unlocked historical harness as a runtime pin", () => {
    expect(
      reviewRuntime(config(), "gpt-primary", {
        sessionId: "review-session",
        updatedAt: 1,
        agentHarnessId: "codex",
      }),
    ).toBe("openclaw");
  });

  it("preserves bare-model provider inference, request params and allowlists", () => {
    const original = config();
    original.agents!.entries!.main = {
      model: "gpt-shared",
      models: { "gpt-shared": { agentRuntime: { id: "auto" } } },
      params: { temperature: 0.4 },
      modelPolicy: { allow: ["relay/gpt-shared", "openai/gpt-primary"] },
    };
    original.models!.providers!.relay = {
      api: "openai-responses",
      baseUrl: "https://relay.example.test/v1",
      models: [model("gpt-shared")],
    };
    const snapshot = structuredClone(original);
    const inference = () =>
      inferUniqueProviderFromConfiguredModels({
        cfg: original,
        agentId: "main",
        model: "gpt-shared",
        allowManifestNormalization: false,
      });
    const allowlist = resolveConfiguredModelPolicyAllow({ cfg: original, agentId: "main" });
    expect(inference()).toBe("relay");
    reviewRuntime(original, "gpt-shared");
    expect(
      resolveSkillCollectionReviewRuntimeOverride({
        config: original,
        agentId: "main",
        provider: "relay",
        modelId: "gpt-shared",
      }),
    ).toBeUndefined();
    expect(inference()).toBe("relay");
    expect(resolveConfiguredModelPolicyAllow({ cfg: original, agentId: "main" })).toEqual(
      allowlist,
    );
    expect(original).toEqual(snapshot);
  });

  it("keeps custom endpoint and non-OpenAI runtime selections unchanged", () => {
    const original = config();
    original.models!.providers!.openai!.baseUrl = "https://relay.example.test/v1";
    original.agents!.entries!.main!.models = {
      "anthropic/*": { agentRuntime: { id: "claude-cli" } },
    };
    expect(reviewRuntime(original)).toBeUndefined();
    expect(
      resolveSkillCollectionReviewRuntimeOverride({
        config: original,
        agentId: "main",
        provider: "anthropic",
        modelId: "claude-test",
      }),
    ).toBeUndefined();
  });
});
