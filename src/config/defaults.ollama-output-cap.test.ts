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

it.each([
  ["kimi-k2.6", 262_144],
  ["kimi-k2.7-code", 262_144],
  ["kimi-k3", 1_048_576],
  ["deepseek-v4-pro", 1_048_576],
  ["deepseek-v4-pro:0813", 1_048_576],
  ["gemma4", 262_144],
  ["gemma4:31b", 262_144],
  ["glm-5.2", 131_072],
  ["gpt-oss:120b", 131_072],
  ["gpt-oss:20b", 131_072],
  ["minimax-m2.7", 196_608],
  ["minimax-m3", 524_288],
  ["mistral-large-3:675b", 262_144],
  ["nemotron-3-nano:30b", 262_144],
  ["nemotron-3-super", 262_144],
  ["nemotron-3-ultra", 262_144],
])("materializes %s from the authored cloud catalog", (id, expected) => {
  expect(materialize("ollama-cloud", id, cloud)?.maxTokens).toBe(expected);
});

it.each<[string, string, number, Partial<ModelDefinitionConfig>?, number?]>([
  ["custom", cloud, 262_144],
  ["custom:cloud", local, 262_144],
  ["custom", local, 8192],
  ["minimax-m3", local, 8192],
  ["kimi-k3", local, 8192],
  ["minimax-m3", local, 8192, { baseUrl: cloud }],
  ["minimax-m3", cloud, 262_144, { baseUrl: local }],
  ["minimax-m3", cloud, 262_144],
  ["kimi-k3:cloud", local, 262_144],
  ["minimax-m3", local, 1024, { maxTokens: 1024 }],
  ["custom", cloud, 1024, { maxTokens: 1024 }],
  ["custom", cloud, 2048, {}, 2048],
])("materializes %s at %s with cap %i", (id, baseUrl, expected, model, providerCap) => {
  const actual = materialize(
    "ollama",
    id,
    baseUrl,
    {
      contextWindow: 262_144,
      params: { num_predict: -1 },
      ...model,
    },
    providerCap,
  );
  expect(actual).toMatchObject({ maxTokens: expected, params: { num_predict: -1 } });
});
