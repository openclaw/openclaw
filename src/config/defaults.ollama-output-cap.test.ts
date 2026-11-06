import path from "node:path";
import { expect, it } from "vitest";
import { loadPluginManifest } from "../plugins/manifest.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { applyModelDefaults } from "./defaults.js";
import type { ModelDefinitionConfig } from "./types.models.js";
import { validateConfigObjectRaw } from "./validation-core.js";

const cloud = "https://ollama.com";
const local = "http://127.0.0.1:11434";
const rootDir = path.resolve("extensions/ollama");
const loaded = loadPluginManifest(rootDir);
if (!loaded.ok) {
  throw new Error(loaded.error);
}
const manifestRegistry = {
  plugins: [createPluginManifestRecordFixture({ ...loaded.manifest, rootDir })],
};

function materialize(
  provider: string,
  id: string,
  baseUrl: string,
  model: Partial<ModelDefinitionConfig> = {},
  maxTokens?: number,
) {
  const config = { baseUrl, api: "ollama", maxTokens, models: [{ id, name: id, ...model }] };
  const parsed = validateConfigObjectRaw({ models: { providers: { [provider]: config } } });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.issues));
  }
  return applyModelDefaults(parsed.config, { manifestRegistry }).models?.providers?.[provider]
    ?.models[0];
}

it.each<[string, string, string, number, Partial<ModelDefinitionConfig>?, number?]>([
  ["ollama-cloud", "minimax-m3", cloud, 131_072],
  ["ollama-cloud", "kimi-k3", cloud, 1_048_576, { contextWindow: 1_048_576 }],
  ["ollama-cloud", "glm-5.2", cloud, 131_072],
  ["ollama", "custom", cloud, 262_144],
  ["ollama", "custom:cloud", local, 262_144],
  ["ollama", "custom", local, 32_768],
  ["ollama", "custom", local, 16_384, { contextWindow: 32_768 }],
  ["ollama", "custom", local, 4096, { contextWindow: 4096 }],
  ["ollama", "minimax-m3", local, 32_768],
  ["ollama", "minimax-m3", local, 32_768, { baseUrl: cloud }],
  ["ollama", "minimax-m3", cloud, 131_072, { baseUrl: local }],
  ["ollama", "custom", cloud, 1024, { maxTokens: 1024 }],
  ["ollama", "custom", cloud, 2048, {}, 2048],
  ["ollama", "custom", local, 2048, {}, 2048],
])(
  "materializes %s/%s at %s with cap %i",
  (provider, id, baseUrl, expected, model, providerCap) => {
    expect(
      materialize(
        provider,
        id,
        baseUrl,
        { contextWindow: 262_144, params: { num_predict: -1 }, ...model },
        providerCap,
      ),
    ).toMatchObject({ maxTokens: expected, params: { num_predict: -1 } });
  },
);
