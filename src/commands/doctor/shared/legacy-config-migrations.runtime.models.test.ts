import { assert, it, expect } from "vitest";
import { createModelVisibilityPolicy } from "../../../agents/model-visibility-policy.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { AgentModelEntryConfig as ModelEntry } from "../../../config/types.js";
import { validateConfigObjectRaw } from "../../../config/validation-core.js";
import {
  collectBlockedLegacyOpenAICodexProviderPlan,
  LEGACY_CONFIG_MIGRATIONS_RUNTIME_MODELS as migrations,
} from "./legacy-config-migrations.runtime.models.js";

function migration(id: string) {
  const entry = migrations.find((candidate) => candidate.id === id);
  assert(entry, `Missing migration: ${id}`);
  return entry;
}

function apply(migrate: ReturnType<typeof migration>, raw: Record<string, unknown>) {
  const changes: string[] = [];
  migrate.apply(raw, changes);
  return changes;
}

function expectUnchanged(migrate: ReturnType<typeof migration>, raw: Record<string, unknown>) {
  const original = structuredClone(raw);
  expect(apply(migrate, raw)).toEqual([]);
  expect(raw).toEqual(original);
}

function providerConfig<T>(providers: T) {
  return { models: { providers } };
}

function route(api: string, baseUrl: string, id: string, compat: Record<string, unknown>) {
  return { api, baseUrl, models: [{ id, compat }] };
}

function allowConfig(models: Record<string, ModelEntry>, modelPolicy?: { allow: string[] }) {
  return { agents: { defaults: { models, ...(modelPolicy ? { modelPolicy } : {}) } } };
}

it("retires pricing while preserving the hosted catalog config", () => {
  const raw = { models: { pricing: { enabled: false }, catalogRefresh: { enabled: true } } };
  migration("models.pricing-retired").apply(raw, []);
  expect(raw.models).toEqual({ catalogRefresh: { enabled: true } });
});

const compatMigration = migration("models.providers.*.models.*.compat->provider-catalog");
it("strips matching and dead compat overrides while preserving divergences", () => {
  const raw = providerConfig({
    anthropic: route("anthropic-messages", "https://api.anthropic.com/v1", "claude-haiku-4-5", {
      codeMode: "capable",
      supportsTemperature: true,
    }),
    openai: route("openai-responses", "https://api.openai.com/v1", "gpt-5.6-sol", {
      supportsReasoningEffort: true,
      supportsTemperature: true,
      nativeWebSearchTool: true,
      requiresMistralToolIds: true,
    }),
  });
  expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toContain("models.providers");
  compatMigration.apply(raw, []);
  const { anthropic, openai } = raw.models.providers;
  expect(anthropic.models[0]?.compat).toEqual({ supportsTemperature: true });
  expect(openai.models[0]?.compat).toEqual({ supportsTemperature: true });
});

it("preserves live compat for custom models and routes", () => {
  const proxy = "http://127.0.0.1:9000/v1";
  const raw = providerConfig({
    anthropic: route("anthropic-messages", proxy, "claude-haiku-4-5", { codeMode: "capable" }),
    custom: route("openai-completions", proxy, "local-model", { supportsTools: false }),
    openai: route("openai-responses", proxy, "gpt-5.6", { supportsReasoningEffort: true }),
  });
  expectUnchanged(compatMigration, raw);
});

const allowMigration = migration("agents.defaults.models->agents.defaults.modelPolicy.allow");
it("defers the entire mixed restriction without opening model access", () => {
  const raw = allowConfig({ bare: {}, "demo/*": {} });
  Object.assign(raw.agents, {
    ownership: "explicit",
    entries: {
      first: { models: { "first/bare": {} } },
      second: { models: { "second/bare": {} } },
    },
  });
  expectUnchanged(allowMigration, raw);
  expect(validateConfigObjectRaw(raw).ok).toBe(true);
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
    ...allowConfig({ "openai/*": {}, "anthropic/claude-sonnet-4-6": { alias: "sonnet" } }),
  };
  expect(apply(allowMigration, raw)).toHaveLength(1);
  expect(raw).toMatchObject({
    agents: { defaults: { modelPolicy: { allow: ["openai/*", "anthropic/claude-sonnet-4-6"] } } },
    meta: { migrations: { modelPolicyAllowlist: true } },
  });
  Object.assign(raw.agents.defaults, { modelPolicy: { allow: ["google/*"] } });
  expect(apply(allowMigration, raw)).toEqual([]);
  expect(raw).toHaveProperty("agents.defaults.modelPolicy.allow", ["google/*"]);
});

it("leaves an explicit allowlist untouched", () => {
  const raw = allowConfig({ "openai/gpt-5.5": {} }, { allow: ["anthropic/*"] });
  expectUnchanged(allowMigration, raw);
});

it("marks a blank-only map migrated without stamping an allowlist", () => {
  const raw = allowConfig({ " ": {} });
  expect(apply(allowMigration, raw)).toHaveLength(1);
  expect(raw.agents.defaults).not.toHaveProperty("modelPolicy");
  expect(raw).toHaveProperty("meta.migrations.modelPolicyAllowlist", true);
  expect(apply(allowMigration, raw)).toEqual([]);
});

it("retains the legacy provider for a scoped wildcard", () => {
  const raw = {
    agents: { defaults: {}, list: [{ id: "worker", modelPolicy: { allow: ["codex/*"] } }] },
    ...providerConfig({
      codex: {
        api: "openai-chatgpt-responses",
        models: [{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol" }],
      },
    }),
  };
  expectUnchanged(migration("models.providers.codex-routes->models.providers.openai"), raw);
  const blocked = collectBlockedLegacyOpenAICodexProviderPlan(raw);
  expect(blocked.warning).toContain("agents.list[0].modelPolicy.allow.0");
  expect(blocked.warning).toContain("authorize unrelated OpenAI models");
});

const windowMigration = migration("models.providers.*.models.*.contextWindow-stale");
it.each(["deepseek-v4-flash", "deepseek/deepseek-v4-flash"])(
  "repairs stale native-provider window: %s",
  (id) => {
    const model = { id, contextWindow: 200_000, maxTokens: 61_440 };
    const raw = providerConfig({ deepseek: { models: [model] } });
    expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toContain("models.providers");
    expect(apply(windowMigration, raw)).toHaveLength(1);
    expect(model).toEqual({ id, contextWindow: 1_000_000, maxTokens: 61_440 });
    expect(apply(windowMigration, raw)).toEqual([]);
  },
);
it.each([{ models: "not-an-array" }, { models: [{ contextWindow: 200_000 }] }])(
  "leaves malformed provider rows unchanged: %j",
  (provider) => expectUnchanged(windowMigration, providerConfig({ deepseek: provider })),
);
