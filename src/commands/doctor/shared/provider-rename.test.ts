import { describe, expect, it } from "vitest";
import { prepareOperatorModelPolicy } from "../../../agents/operator-model-policy.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { ModelDefinitionConfig } from "../../../config/types.models.js";
import {
  applyProviderRenames,
  planProviderRenames,
  rewriteProviderModelRef,
  type ProviderRename,
} from "./provider-rename.js";

const renames: ProviderRename[] = [
  { from: "ollama", to: "ollama-cloud", baseUrl: "https://ollama.com" },
];

function model(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 4096,
  };
}

function configFor(baseUrl: string): OpenClawConfig {
  return {
    models: { providers: { ollama: { baseUrl, api: "ollama", models: [model("qwen:cloud")] } } },
    agents: { defaults: { model: "ollama/qwen:cloud" } },
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
    const result = applyProviderRenames(config, planProviderRenames(config, renames));
    expect(result.config.models?.providers?.["ollama-cloud"]).toEqual({
      baseUrl: "https://ollama.com",
      api: "ollama",
      apiKey: targetKey,
      headers: { "X-Source": "source", "X-Target": "target" },
      models: [{ ...model("qwen:cloud"), name: "authored" }, model("other"), model("source-only")],
    });
    expect(result.config.models?.providers?.ollama).toBeUndefined();
    expect(result.config.auth).toEqual(before.auth);
    expect(config).toEqual(before);
    expect(
      applyProviderRenames(result.config, planProviderRenames(result.config, renames)),
    ).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it("rewrites every reference location, drops profile pins once, and preserves policy denials", () => {
    const config = configFor("https://ollama.com");
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
    const fixture = {
      ...Object.fromEntries(scalarKeys.map((key) => [key, "ollama/qwen:cloud@ollama:default"])),
      ...Object.fromEntries(
        arrayKeys.map((key) => [key, ["ollama/qwen:cloud@ollama:default", "custom/keep"]]),
      ),
      models: {
        "ollama/qwen:cloud": { alias: "old" },
        "ollama-cloud/qwen:cloud": { alias: "canonical" },
      },
      mediaModels: { image: "ollama/image" },
      modelByChannel: { telegram: "ollama/channel" },
      media: { provider: "ollama", model: "vision" },
      unrelated: "ollama/qwen:cloud",
    };
    Object.assign(config, { fixture });
    config.agents!.entries = { work: { model: "ollama/work@ollama:work" } };
    config.gateway = {
      roles: {
        default: "restricted",
        definitions: {
          restricted: {
            agents: "*",
            scopes: ["operator.write"],
            sessions: { others: "none" },
            modelPolicy: { allow: ["ollama/*"], deny: ["ollama/blocked", "ollama/private*"] },
          },
        },
      },
    };
    const result = applyProviderRenames(config, renames);
    expect(result.config).toMatchObject({
      fixture: {
        ...Object.fromEntries(scalarKeys.map((key) => [key, "ollama-cloud/qwen:cloud"])),
        ...Object.fromEntries(
          arrayKeys.map((key) => [key, ["ollama-cloud/qwen:cloud", "custom/keep"]]),
        ),
        models: { "ollama-cloud/qwen:cloud": { alias: "canonical" } },
        mediaModels: { image: "ollama-cloud/image" },
        modelByChannel: { telegram: "ollama-cloud/channel" },
        media: { provider: "ollama-cloud", model: "vision" },
        unrelated: "ollama/qwen:cloud",
      },
      agents: { entries: { work: { model: "ollama-cloud/work" } } },
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
    expect(rewriteProviderModelRef("ollama/model@20261001@q4_k_m@ollama:default", renames)).toBe(
      "ollama-cloud/model@20261001@q4_k_m",
    );
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
