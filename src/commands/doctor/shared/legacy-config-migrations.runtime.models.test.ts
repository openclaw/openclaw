import { expectDefined } from "@openclaw/normalization-core";
import { describe, it, expect } from "vitest";
import { createModelVisibilityPolicy } from "../../../agents/model-visibility-policy.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { validateConfigObjectRaw } from "../../../config/validation-core.js";
import {
  collectBlockedLegacyOpenAICodexProviderPlan,
  LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS,
} from "./legacy-config-migrations.runtime.models.js";

function migration(id: string) {
  return expectDefined(
    LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS.find((entry) => entry.id === id),
    id,
  );
}

function expectUnchanged(migrate: ReturnType<typeof migration>, raw: Record<string, unknown>) {
  const original = structuredClone(raw);
  const changes: string[] = [];
  migrate.apply(raw, changes);
  expect(raw).toEqual(original);
  expect(changes).toEqual([]);
}

function providerConfig(providers: Record<string, unknown>) {
  return { models: { providers } };
}

it.each<[Record<string, unknown>, Record<string, unknown>, string[]]>([
  [{ temperature: 0 }, { qwen_thinking_format: false }, ["models.providers.vllm.models"]],
])("detects owned vLLM aliases: %j %j", (providerParams, modelParams, paths) => {
  const raw = {
    models: {
      providers: {
        vllm: { params: providerParams, models: [{ id: "local-model", params: modelParams }] },
      },
    },
  };
  expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toEqual(paths);
});

it("retires pricing while preserving the hosted catalog config", () => {
  const raw = { models: { pricing: { enabled: false }, catalogRefresh: { enabled: true } } };
  migration("models.pricing-retired").apply(raw, []);
  expect(raw.models).toEqual({ catalogRefresh: { enabled: true } });
});

describe("model compat catalog ownership", () => {
  const migrate = migration("models.providers.*.models.*.compat->provider-catalog");
  it("strips matching and dead overrides while preserving divergences", () => {
    const anthropic = {
      id: "claude-haiku-4-5",
      compat: { codeMode: "capable", supportsTemperature: true },
    };
    const openai = {
      id: "gpt-5.6-sol",
      compat: {
        supportsReasoningEffort: true,
        supportsTemperature: true,
        nativeWebSearchTool: true,
        requiresMistralToolIds: true,
      },
    };
    const raw = providerConfig({
      anthropic: {
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
        models: [anthropic],
      },
      openai: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        models: [openai],
      },
    });
    const detect = () =>
      migrate.legacyRules?.map((rule) => rule.match?.(raw.models.providers, raw));
    expect(detect()).toEqual([true, true, true]);
    migrate.apply(raw, []);
    expect(anthropic.compat).toEqual({ supportsTemperature: true });
    expect(openai.compat).toEqual({ supportsTemperature: true });
    expect(detect()).toEqual([false, false, true]);
  });

  it("preserves live compat for custom models and routes", () => {
    const raw = providerConfig({
      anthropic: {
        api: "anthropic-messages",
        baseUrl: "http://127.0.0.1:9200/v1",
        models: [{ id: "claude-haiku-4-5", compat: { codeMode: "capable" } }],
      },
      custom: {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:9000/v1",
        models: [{ id: "local-model", compat: { supportsTools: false } }],
      },
      openai: {
        api: "openai-responses",
        baseUrl: "http://127.0.0.1:9100/v1",
        models: [{ id: "gpt-5.6", compat: { supportsReasoningEffort: true } }],
      },
    });
    expectUnchanged(migrate, raw);
  });
});

describe("explicit model allow policy migration", () => {
  const migrate = migration("agents.defaults.models->agents.defaults.modelPolicy.allow");
  it("defers the entire mixed restriction without opening model access", () => {
    const raw: OpenClawConfig = {
      agents: {
        defaults: { models: { bare: {}, "demo/*": {} } },
        ownership: "explicit",
        entries: {
          first: { models: { "first/bare": {} } },
          second: { models: { "second/bare": {} } },
        },
      },
    };
    const original = structuredClone(raw);
    const changes: string[] = [];
    migrate.apply(raw, changes);
    expect(validateConfigObjectRaw(raw).ok).toBe(true);
    expect(raw).toEqual(original);
    expect(changes).toEqual([]);
    expect(migrate.legacyRules?.[1]?.match?.(raw.agents?.defaults?.models, raw)).toBe(true);
    for (const agentId of ["first", "second"]) {
      const policy = createModelVisibilityPolicy({
        cfg: raw,
        catalog: [],
        defaultProvider: "default",
        agentId,
      });
      expect(policy.allowAny).toBe(false);
      expect(policy.allows({ provider: agentId, model: "bare" })).toBe(true);
      expect(policy.allows({ provider: "unrelated", model: "denied" })).toBe(false);
    }
  });

  it("preserves the restriction after a new-version write and does not overwrite later policy edits", () => {
    const raw = {
      meta: { lastTouchedVersion: "2026.7.2" },
      agents: {
        defaults: {
          models: { "openai/*": {}, "anthropic/claude-sonnet-4-6": { alias: "sonnet" } },
        },
      },
    };
    const changes: string[] = [];
    expect(migrate.legacyRules?.[0]?.match?.(raw.agents.defaults.models, raw)).toBe(true);
    migrate.apply(raw, changes);
    expect(raw).toMatchObject({
      agents: { defaults: { modelPolicy: { allow: ["openai/*", "anthropic/claude-sonnet-4-6"] } } },
      meta: { migrations: { modelPolicyAllowlist: true } },
    });
    expect(changes).toHaveLength(1);
    expect(migrate.legacyRules?.[0]?.match?.(raw.agents.defaults.models, raw)).toBe(false);
    Object.assign(raw.agents.defaults, { modelPolicy: { allow: ["google/*"] } });
    const secondChanges: string[] = [];
    migrate.apply(raw, secondChanges);
    expect(raw).toHaveProperty("agents.defaults.modelPolicy.allow", ["google/*"]);
    expect(secondChanges).toEqual([]);
  });

  it("leaves an explicit allowlist untouched", () => {
    const raw = {
      agents: {
        defaults: { models: { "openai/gpt-5.5": {} }, modelPolicy: { allow: ["anthropic/*"] } },
      },
    };
    expectUnchanged(migrate, raw);
  });

  it("marks a blank-only map migrated without stamping an allowlist", () => {
    const raw = { agents: { defaults: { models: { " ": {} } } } };
    const changes: string[] = [];
    migrate.apply(raw, changes);
    expect(raw.agents.defaults).not.toHaveProperty("modelPolicy");
    expect(raw).toHaveProperty("meta.migrations.modelPolicyAllowlist", true);
    expect(changes).toHaveLength(1);
    const secondChanges: string[] = [];
    migrate.apply(raw, secondChanges);
    expect(secondChanges).toEqual([]);
  });
});

it.each([
  {
    agents: { defaults: {}, list: [{ id: "worker", modelPolicy: { allow: ["codex/*"] } }] },
    path: "agents.list[0].modelPolicy.allow.0",
  },
])("retains the legacy provider for a scoped wildcard: $path", ({ agents, path }) => {
  const raw = {
    agents,
    models: {
      providers: {
        codex: {
          api: "openai-chatgpt-responses",
          models: [{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol" }],
        },
      },
    },
  };
  const changes: string[] = [];
  migration("models.providers.codex-routes->models.providers.openai").apply(raw, changes);
  expect(raw.models.providers).toHaveProperty("codex");
  expect(raw.models.providers).not.toHaveProperty("openai");
  expect(changes).toEqual([]);
  const blocked = collectBlockedLegacyOpenAICodexProviderPlan(raw);
  expect(blocked.warning).toContain(path);
  expect(blocked.warning).toContain("authorize unrelated OpenAI models");
});

describe("stale contextWindow migration", () => {
  const migrate = migration("models.providers.*.models.*.contextWindow-stale");
  it.each([
    { provider: "deepseek", id: "deepseek-v4-flash", before: 200_000, after: 1_000_000 },
    { provider: "deepseek", id: "deepseek/deepseek-v4-flash", before: 200_000, after: 1_000_000 },
  ])(
    "repairs only stale native-provider windows: $provider/$id ($before)",
    ({ provider, id, before, after }) => {
      const model = { id, contextWindow: before, maxTokens: 61_440 };
      const raw = { models: { providers: { [provider]: { models: [model] } } } };
      const changes: string[] = [];
      expect(migrate.legacyRules?.[0]?.match?.(raw.models.providers, raw)).toBe(before !== after);
      migrate.apply(raw, changes);
      expect(model).toEqual({ id, contextWindow: after, maxTokens: 61_440 });
      expect(changes).toHaveLength(before !== after ? 1 : 0);
      expect(migrate.legacyRules?.[0]?.match?.(raw.models.providers, raw)).toBe(false);
      const secondChanges: string[] = [];
      migrate.apply(raw, secondChanges);
      expect(secondChanges).toEqual([]);
    },
  );
  it.each([{ models: "not-an-array" }, { models: [{ contextWindow: 200_000 }] }])(
    "leaves malformed provider rows unchanged: %j",
    (provider) => {
      const raw = { models: { providers: { deepseek: provider } } };
      expectUnchanged(migrate, raw);
    },
  );
});
