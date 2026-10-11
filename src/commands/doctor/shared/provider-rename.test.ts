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

const declaration: ProviderRename = {
  from: "ollama",
  to: "ollama-cloud",
  baseUrl: "https://ollama.com",
};
const declarations = [declaration];

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
  ])("matches only the declared origin: %s", (baseUrl, matches) => {
    const config = configFor(baseUrl);
    const plans = planProviderRenames(config, declarations);
    expect(plans).toEqual(matches ? declarations : []);
    const result = applyProviderRenames(config, plans);
    expect(result.config.agents?.defaults?.model).toBe(
      matches ? "ollama-cloud/qwen:cloud" : "ollama/qwen:cloud",
    );
    if (!matches) {
      expect(result).toEqual({ config, changes: [] });
    }
  });

  it("keeps local and unrelated custom providers even when cloud model IDs coexist", () => {
    const config = configFor("http://localhost:11434");
    config.models!.providers!["custom"] = {
      baseUrl: "https://ollama.com",
      models: [model("qwen:cloud")],
    };
    config.models!.providers!["ollama-cloud"] = {
      baseUrl: "https://ollama.com",
      models: [model("remote:cloud")],
    };
    config.agents!.defaults!.model = {
      primary: "ollama/qwen:cloud",
      fallbacks: ["custom/qwen:cloud", "ollama-cloud/remote:cloud"],
    };
    expect(applyProviderRenames(config, planProviderRenames(config, declarations))).toEqual({
      config,
      changes: [],
    });
  });

  it("merges catalogs, retains canonical conflicts and preserves authored auth", () => {
    const config = configFor("https://ollama.com/api");
    const sourceKey = { source: "env", provider: "default", id: "OLLAMA_API_KEY" } as const;
    const targetKey = { source: "env", provider: "default", id: "CLOUD_API_KEY" } as const;
    config.models!.providers!.ollama.apiKey = sourceKey;
    config.models!.providers!.ollama.headers = { "X-Source": "source" };
    config.models!.providers!.ollama.models.push(model("source-only"));
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
    const result = applyProviderRenames(config, planProviderRenames(config, declarations));
    const target = result.config.models?.providers?.["ollama-cloud"];
    expect(target?.models.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "qwen:cloud", name: "authored" },
      { id: "other", name: "other" },
      { id: "source-only", name: "source-only" },
    ]);
    expect(target?.apiKey).toEqual(targetKey);
    expect(target?.headers).toEqual({ "X-Source": "source", "X-Target": "target" });
    expect(result.config.models?.providers?.ollama).toBeUndefined();
    expect(result.config.auth).toEqual(before.auth);
    expect(config).toEqual(before);
    expect(
      applyProviderRenames(result.config, planProviderRenames(result.config, declarations)),
    ).toEqual({
      config: result.config,
      changes: [],
    });
  });

  it("preserves the source SecretRef and all distinct models when moving", () => {
    const config = configFor("https://ollama.com");
    const key = { source: "env", provider: "default", id: "OLLAMA_API_KEY" } as const;
    config.models!.providers!.ollama.apiKey = key;
    config.models!.providers!.ollama.models.push(model("unique"));
    const result = applyProviderRenames(config, declarations);
    expect(result.config.models?.providers?.["ollama-cloud"]?.apiKey).toEqual(key);
    expect(result.config.models?.providers?.["ollama-cloud"]?.models.map(({ id }) => id)).toEqual([
      "qwen:cloud",
      "unique",
    ]);
  });

  it.each([
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
    "fallback",
    "fallbacks",
    "allowedModels",
    "modelFallbacks",
    "imageModelFallbacks",
  ])("rewrites the existing model-reference slot %s", (key) => {
    const config = configFor("https://ollama.com");
    const array = [
      "fallback",
      "fallbacks",
      "allowedModels",
      "modelFallbacks",
      "imageModelFallbacks",
    ].includes(key);
    Object.assign(config, {
      [key]: array
        ? ["ollama/qwen:cloud@ollama:default", "custom/qwen:cloud"]
        : "ollama/qwen:cloud@ollama:default",
    });
    const result = applyProviderRenames(config, declarations);
    expect(result.config).toMatchObject({
      [key]: array ? ["ollama-cloud/qwen:cloud", "custom/qwen:cloud"] : "ollama-cloud/qwen:cloud",
    });
  });

  it("rewrites maps, provider/model pairs, policy and surface slots through the shared walker", () => {
    const config = configFor("https://ollama.com");
    Object.assign(config, {
      fixture: {
        models: {
          "ollama/qwen:cloud": { alias: "old" },
          "ollama-cloud/qwen:cloud": { alias: "canonical" },
        },
        mediaModels: { image: "ollama/image" },
        modelByChannel: { telegram: "ollama/channel" },
        modelPolicy: { allow: ["ollama/*"] },
        media: { provider: "ollama", model: "vision" },
        unrelated: "ollama/qwen:cloud",
      },
    });
    expect(applyProviderRenames(config, declarations).config).toMatchObject({
      fixture: {
        models: { "ollama-cloud/qwen:cloud": { alias: "canonical" } },
        mediaModels: { image: "ollama-cloud/image" },
        modelByChannel: { telegram: "ollama-cloud/channel" },
        modelPolicy: { allow: ["ollama-cloud/*"] },
        media: { provider: "ollama-cloud", model: "vision" },
        unrelated: "ollama/qwen:cloud",
      },
    });
  });

  it.each(["ollama/blocked", "ollama/blocked*"])(
    "preserves role model denials after renaming %s",
    (denied) => {
      const config = configFor("https://ollama.com");
      config.gateway = {
        roles: {
          default: "restricted",
          definitions: {
            restricted: {
              agents: "*",
              scopes: ["operator.write"],
              sessions: { others: "none" },
              modelPolicy: { allow: ["ollama/*"], deny: [denied] },
            },
          },
        },
      };
      const { config: migrated } = applyProviderRenames(config, declarations);
      const policy = prepareOperatorModelPolicy({
        cfg: migrated,
        policy: migrated.gateway!.roles!.definitions.restricted!.modelPolicy,
        manifestPlugins: [],
      });
      expect(policy?.allows({ provider: "ollama-cloud", model: "blocked" })).toBe(false);
      expect(policy?.allows({ provider: "ollama-cloud", model: "allowed" })).toBe(true);
      expect(policy?.allows({ provider: "custom", model: "allowed" })).toBe(false);
    },
  );

  it.each([
    { ids: [], selected: undefined, expected: "ollama-cloud/model" },
    {
      ids: ["ollama-cloud:work"],
      selected: "ollama-cloud:work",
      expected: "ollama-cloud/model@ollama-cloud:work",
    },
    {
      ids: ["ollama-cloud:work", "ollama-cloud:default"],
      selected: "ollama-cloud:default",
      expected: "ollama-cloud/model@ollama-cloud:default",
    },
    {
      ids: ["ollama-cloud:work", "ollama-cloud:other"],
      selected: undefined,
      expected: "ollama-cloud/model",
    },
  ])(
    "replaces cross-provider pins using only bound target profiles: $expected",
    ({ ids, selected, expected }) => {
      const bound = [{ ...declaration, targetAuthProfileIds: ids, targetAuthProfileId: selected }];
      expect(rewriteProviderModelRef("ollama/model@ollama:default", bound)).toBe(expected);
      expect(rewriteProviderModelRef("ollama/model", bound)).toBe("ollama-cloud/model");
      const config = configFor("https://ollama.com");
      config.agents!.defaults!.model = "ollama/model@ollama:default";
      const result = applyProviderRenames(config, bound);
      expect(result.changes).toContain(
        `Upgraded config.agents.defaults.model from "ollama/model@ollama:default" to "${expected}".`,
      );
      expect(result.changes).toContain(
        "Provider migration updated auth profile pins; to choose another saved account, re-pin the model with /model <provider/model>@<profile>.",
      );
    },
  );

  it("preserves known target pins and model date/quantization suffixes", () => {
    const bound = [
      {
        ...declaration,
        targetAuthProfileIds: ["ollama-cloud:work", "ollama-cloud:default"],
        targetAuthProfileId: "ollama-cloud:default",
      },
    ];
    expect(rewriteProviderModelRef("ollama/model@ollama-cloud:work", bound)).toBe(
      "ollama-cloud/model@ollama-cloud:work",
    );
    expect(rewriteProviderModelRef("ollama/model@20261001@q4_k_m", bound)).toBe(
      "ollama-cloud/model@20261001@q4_k_m",
    );
    expect(rewriteProviderModelRef("ollama/model@20261001@q4_k_m@ollama:default", bound)).toBe(
      "ollama-cloud/model@20261001@q4_k_m@ollama-cloud:default",
    );
  });

  it.each([
    "ollamax/model",
    "custom/model:cloud",
    "ollama-cloud/model",
    "ollama:default",
    "model:cloud",
  ])("leaves unrelated ref %s untouched", (ref) => {
    expect(rewriteProviderModelRef(ref, declarations)).toBeUndefined();
  });
});
