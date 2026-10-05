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
import { rewriteKnownModelRefs } from "./legacy-config-migrations.runtime.models.refs.js";

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

describe("deep canonical model-reference migration", () => {
  const depth = 10_000;
  const migrate = migration("models.canonical-model-refs");
  const rule = expectDefined(
    migrate.legacyRules?.find((entry) => entry.path[0] === "agents"),
    "registered agents model-reference migration rule",
  );

  it.each(["objects", "arrays"])("detects and repairs model refs nested in %s", (shape) => {
    const leaf = {
      model: "google/gemini-3-pro-preview",
      fallbacks: ["google/gemini-3-pro-preview", "custom/unchanged"],
      note: "google/gemini-3-pro-preview",
    };
    let nested: unknown = leaf;
    for (let index = 0; index < depth; index++) {
      nested = shape === "arrays" ? [nested] : { x: nested };
    }
    const raw = { agents: nested };
    const changes: string[] = [];

    expect(rule.match?.(raw.agents, raw)).toBe(true);
    migrate.apply(raw, changes);

    let repaired: unknown = raw.agents;
    for (let index = 0; index < depth; index++) {
      repaired = Array.isArray(repaired) ? repaired[0] : (repaired as Record<string, unknown>).x;
    }
    expect(repaired).toEqual({
      model: "google/gemini-3.1-pro-preview",
      fallbacks: ["google/gemini-3.1-pro-preview", "custom/unchanged"],
      note: "google/gemini-3-pro-preview",
    });
    const leafPath = `config.agents${(shape === "arrays" ? ".0" : ".x").repeat(depth)}`;
    expect(changes).toEqual([
      `Upgraded ${leafPath}.model from "google/gemini-3-pro-preview" to "google/gemini-3.1-pro-preview".`,
      `Upgraded ${leafPath}.fallbacks.0 from "google/gemini-3-pro-preview" to "google/gemini-3.1-pro-preview".`,
    ]);
    expect(leaf.model).toBe("google/gemini-3-pro-preview");
    expect(rule.match?.(raw.agents, raw)).toBe(false);
    const repairedRoot = raw.agents;
    const repeatedChanges: string[] = [];
    migrate.apply(raw, repeatedChanges);
    expect(raw.agents).toBe(repairedRoot);
    expect(repeatedChanges).toEqual([]);
  });
});

it.each<[Record<string, unknown>, Record<string, unknown>, string[]]>([
  [{ qwenThinkingFormat: null }, { temperature: 0 }, ["models.providers.vllm.params"]],
  [{ temperature: 0 }, { qwen_thinking_format: false }, ["models.providers.vllm.models"]],
  [{ temperature: 0 }, { temperature: 0 }, []],
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
    agents: { defaults: { modelPolicy: { allow: ["codex/*"] } } },
    path: "agents.defaults.modelPolicy.allow.0",
  },
  {
    agents: { defaults: {}, list: [{ id: "worker", modelPolicy: { allow: ["codex/*"] } }] },
    path: "agents.list[0].modelPolicy.allow.0",
  },
  {
    agents: { entries: { worker: { modelPolicy: { allow: ["codex/*"] } } } },
    path: "agents.entries.worker.modelPolicy.allow.0",
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
    { provider: "deepseek", id: "deepseek-v4-flash", before: 500_000, after: 500_000 },
    { provider: "openrouter", id: "deepseek/deepseek-v4-flash", before: 200_000, after: 200_000 },
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

describe("rewriteKnownModelRefs deep nesting", () => {
  // Regression: deeply nested config used to overflow the call stack because
  // rewriteModelRefs recursed once per nesting level. The traversal is now
  // iterative, so arbitrary depth must complete without RangeError.
  it("completes without RangeError for deeply nested config", () => {
    const depth = 5000;
    let value: unknown = "anthropic/claude-3-sonnet";
    for (let i = 0; i < depth; i++) {
      value = { x: value };
    }
    const changes: string[] = [];

    expect(() => rewriteKnownModelRefs(value, "config", changes)).not.toThrow();
  });

  it("rewrites a deeply nested model ref and reports its notice", () => {
    // A recognized retired model ref (openai/gpt-4) buried under many levels
    // must still be reached for normalization, rewritten to its successor,
    // flagged as changed, and emit a notice naming the full deep path.
    const depth = 3000;
    let value: unknown = { model: "openai/gpt-4" };
    for (let i = 0; i < depth; i++) {
      value = { agents: value };
    }
    const changes: string[] = [];

    const result = rewriteKnownModelRefs(value, "config", changes);

    expect(result.changed).toBe(true);
    expect(changes).toHaveLength(1);
    // The notice names the full deep path down to the rewritten leaf.
    const expectedPath = "config" + ".agents".repeat(depth) + ".model";
    expect(changes[0]).toBe(`Upgraded ${expectedPath} from "openai/gpt-4" to "openai/gpt-5.5".`);
    // The deeply nested leaf model was rewritten in place.
    let cursor: unknown = result.value;
    for (let i = 0; i < depth; i++) {
      cursor = (cursor as Record<string, unknown>).agents;
    }
    expect((cursor as { model: string }).model).toBe("openai/gpt-5.5");
  });

  it("preserves depth-first notice order for mixed arrays", () => {
    // An array with an object entry before a string entry must report the
    // object's notice first, matching the recursive version's traversal.
    const value = [{ model: "openai/gpt-4" }, "openai/gpt-4o"];
    const changes: string[] = [];

    rewriteKnownModelRefs(value, "config.fallbacks", changes);

    expect(changes).toHaveLength(2);
    expect(changes[0]).toContain("config.fallbacks.0.model");
    expect(changes[1]).toContain("config.fallbacks.1");
  });
});
