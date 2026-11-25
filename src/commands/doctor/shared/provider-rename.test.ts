import { describe, expect, it } from "vitest";
import { prepareOperatorModelPolicy } from "../../../agents/operator-model-policy.js";
import type { GatewayOperatorRoleDefinition } from "../../../config/types.gateway.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { createTestModelDefinition as model } from "../../test-runtime-config-helpers.js";
import {
  applyProviderRenames,
  planProviderRenames,
  rewriteProviderModelRef,
  type ProviderRename,
} from "./provider-rename.js";

const renames: ProviderRename[] = [
  { from: "ollama", to: "ollama-cloud", baseUrl: "https://ollama.com" },
];

function configFor(baseUrl: string): OpenClawConfig {
  return {
    models: { providers: { ollama: { baseUrl, api: "ollama", models: [model("qwen:cloud")] } } },
    agents: { defaults: { model: "ollama/qwen:cloud" } },
  };
}

function migrate(config: OpenClawConfig) {
  return applyProviderRenames(config, planProviderRenames(config, renames));
}

function expectStable(input: OpenClawConfig, before: OpenClawConfig, migrated: OpenClawConfig) {
  expect(input).toEqual(before);
  expect(migrate(migrated)).toEqual({ config: migrated, changes: [] });
}

function embeddingSearch(baseUrl: string) {
  return { provider: "ollama" as const, model: "nomic-embed-text", remote: { baseUrl } };
}

function references(provider: string, pin = "") {
  const ref = `${provider}/qwen:cloud${pin}`;
  const scalarKeys = [
    "model",
    "primary",
    "summaryModel",
    "imageModel",
    "utilityModel",
    "voiceModel",
    "imageGenerationModel",
    "musicGenerationModel",
    "pdfModel",
    "videoGenerationModel",
    "preferredModel",
  ];
  const arrayKeys = [
    "fallback",
    "fallbacks",
    "allowedModels",
    "modelFallbacks",
    "imageModelFallbacks",
  ];
  return {
    ...Object.fromEntries(scalarKeys.map((key) => [key, ref])),
    ...Object.fromEntries(arrayKeys.map((key) => [key, [ref, "custom/keep"]])),
    mediaModels: { image: `${provider}/image` },
    modelByChannel: { telegram: `${provider}/channel` },
    media: { provider, model: "vision" },
    unrelated: "ollama/qwen:cloud",
  };
}

describe("provider rename config migration", () => {
  it.each([
    ["https://ollama.com", true],
    ["https://OLLAMA.COM/", true],
    ["https://ollama.com:443/api/v1/", true],
    ["https://ollama.com/path?query=1#fragment", true],
    ["http://ollama.com", false],
    ["https://ollama.com:444", false],
    ["https://ollama.com.example/api", false],
    ["http://localhost:11434", false],
    ["http://127.0.0.1:11434", false],
    ["http://192.168.1.5:11434", false],
    ["https://inference.example/api", false],
    ["not a URL", false],
  ])("matches only the hosted origin: %s", (baseUrl, matches) => {
    const config = configFor(baseUrl);
    config.models!.providers!["custom"] = { baseUrl: "https://ollama.com", models: [] };
    config.models!.providers!["ollama-cloud"] = { baseUrl: "https://ollama.com", models: [] };
    const plans = planProviderRenames(config, renames);
    expect(plans).toEqual(matches ? renames : []);
    const result = applyProviderRenames(config, plans);
    expect(result.config.agents?.defaults?.model).toBe(
      matches ? "ollama-cloud/qwen:cloud" : "ollama/qwen:cloud",
    );
    expect(result.config.models?.providers?.custom).toEqual(config.models?.providers?.custom);
    if (!matches) {
      expect(result).toEqual({ config, changes: [] });
    }
  });

  it.each([
    ["http://127.0.0.1:11434", "ollama"],
    ["http://192.168.1.5:11434", "ollama"],
    ["https://embeddings.example/api", "ollama"],
    ["https://ollama.com/v1", "ollama-cloud"],
    ["", "ollama-cloud"],
    ["   ", "ollama-cloud"],
  ])("respects the memory embedding endpoint %s", (baseUrl, provider) => {
    const config = configFor("https://ollama.com/v1");
    config.memory = { search: embeddingSearch(baseUrl) };
    const result = migrate(config);
    expect(result.config.memory?.search).toEqual({
      provider,
      model: "nomic-embed-text",
      remote: { baseUrl },
    });
    expect(result.config.agents?.defaults?.model).toBe("ollama-cloud/qwen:cloud");
    expect(result.config.models?.providers?.ollama).toBeUndefined();
    expect(config.memory.search?.provider).toBe("ollama");
    expect(
      result.changes.some((change) => change.includes("config.memory.search provider/model")),
    ).toBe(provider === "ollama-cloud");
  });

  it.each([
    ["https://ollama.com/v1", { remote: { baseUrl: "http://127.0.0.1:11434" } }, "ollama"],
    ["http://127.0.0.1:11434", { provider: "ollama", model: "nomic-embed-text" }, "ollama"],
    ["http://127.0.0.1:11434", { remote: { baseUrl: "https://ollama.com/v1" } }, "ollama-cloud"],
    ["https://ollama.com/v1", { model: "nomic-embed-text" }, "ollama-cloud"],
  ] as const)(
    "preserves the effective per-agent embedding route: %s %j",
    (defaultsBaseUrl, search, expected) => {
      const config = configFor("https://ollama.com/v1");
      config.memory = { search: embeddingSearch(defaultsBaseUrl) };
      config.agents!.entries = { work: { memory: { search } } };
      const before = structuredClone(config);
      const result = migrate(config);
      const migrated = result.config.agents?.entries?.work?.memory?.search;
      expect(migrated?.provider ?? result.config.memory?.search?.provider).toBe(expected);
      expect(migrated?.model ?? result.config.memory?.search?.model).toBe("nomic-embed-text");
      expect(migrated?.remote).toEqual(before.agents?.entries?.work?.memory?.search?.remote);
      expect(result.config.agents?.defaults?.model).toBe("ollama-cloud/qwen:cloud");
      expectStable(config, before, result.config);
    },
  );

  it("merges into existing cloud settings without mutating input or authored auth, then is idempotent", () => {
    const config = configFor("https://ollama.com/api");
    const targetKey = { source: "env", provider: "default", id: "CLOUD_API_KEY" } as const;
    config.models!.providers!.ollama!.apiKey = {
      source: "env",
      provider: "default",
      id: "OLLAMA_API_KEY",
    };
    config.models!.providers!.ollama!.headers = { "X-Source": "source" };
    config.models!.providers!.ollama!.models.push(model("source-only"));
    config.models!.providers!["ollama-cloud"] = {
      baseUrl: "https://ollama.com",
      apiKey: targetKey,
      headers: { "X-Target": "target" },
      models: [{ ...model("qwen:cloud"), name: "authored" }, model("other")],
    };
    config.auth = {
      profiles: { "ollama:default": { provider: "ollama", mode: "api_key" } },
      order: { ollama: ["ollama:default"] },
    };
    const before = structuredClone(config);
    const result = migrate(config);
    expect(result.config.models?.providers?.["ollama-cloud"]).toEqual({
      baseUrl: "https://ollama.com",
      api: "ollama",
      apiKey: targetKey,
      headers: { "X-Source": "source", "X-Target": "target" },
      models: [{ ...model("qwen:cloud"), name: "authored" }, model("other"), model("source-only")],
    });
    expect(result.config.models?.providers?.ollama).toBeUndefined();
    expect(result.config.auth).toEqual(before.auth);
    expectStable(config, before, result.config);
  });

  it("rewrites every reference location, drops profile pins once, and preserves policy denials", () => {
    const config = configFor("https://ollama.com");
    Object.assign(config, {
      fixture: {
        ...references("ollama", "@ollama:default"),
        models: {
          "ollama/qwen:cloud": { alias: "old" },
          "ollama-cloud/qwen:cloud": { alias: "canonical" },
        },
      },
    });
    config.agents!.entries = { work: { model: "ollama/model@20261001@q4_k_m@ollama:work" } };
    const role: GatewayOperatorRoleDefinition = {
      agents: "*",
      scopes: ["operator.write"],
      sessions: { others: "none" },
      modelPolicy: { allow: ["ollama/*"], deny: ["ollama/blocked", "ollama/private*"] },
    };
    config.gateway = { roles: { definitions: { restricted: role } } };
    const result = applyProviderRenames(config, renames);
    expect(result.config).toMatchObject({
      fixture: {
        ...references("ollama-cloud"),
        models: { "ollama-cloud/qwen:cloud": { alias: "canonical" } },
      },
      agents: { entries: { work: { model: "ollama-cloud/model@20261001@q4_k_m" } } },
    });
    expect(result.changes.filter((change) => /re-pin/i.test(change))).toHaveLength(1);
    const policy = prepareOperatorModelPolicy({
      cfg: result.config,
      policy: result.config.gateway!.roles!.definitions.restricted!.modelPolicy,
      manifestPlugins: [],
    });
    for (const id of ["blocked", "private-model"]) {
      expect(policy?.allows({ provider: "ollama-cloud", model: id })).toBe(false);
    }
    expect(policy?.allows({ provider: "ollama-cloud", model: "allowed" })).toBe(true);
    expect(policy?.allows({ provider: "custom", model: "allowed" })).toBe(false);
    for (const ref of [
      "ollamax/model",
      "custom/model:cloud",
      "ollama-cloud/model",
      "ollama:default",
      "model:cloud",
    ]) {
      expect(rewriteProviderModelRef(ref, renames)).toBeUndefined();
    }
  });
});
