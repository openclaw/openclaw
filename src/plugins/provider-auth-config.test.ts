import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { configForProviders } from "../agents/model-auth.fixtures.test-support.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildCatalogModel } from "../plugin-sdk/provider-catalog.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createProviderAuthConfigPatch, writeProviderAuthConfig } from "./provider-auth-config.js";

it("creates no credential-only delta for absent model maps and authored null metadata", () => {
  const model = buildCatalogModel("gpt-fixture", { thinkingLevelMap: { off: null } });
  const config: OpenClawConfig = configForProviders({
    openai: { baseUrl: "https://api.openai.com/v1", models: [model] },
  });

  expect(createProviderAuthConfigPatch(config, structuredClone(config))).toEqual({});
  expect(config.agents?.defaults?.models).toBeUndefined();
  expect(config.models?.providers?.openai?.models[0]?.thinkingLevelMap?.off).toBeNull();
});

it.each([
  { sourceKey: "LiteLLM", patchKey: "litellm", canonicalKey: "litellm" },
  { sourceKey: "local-proxy", patchKey: "LoCaL-PrOxY", canonicalKey: "local-proxy" },
])(
  "saves one canonical provider after applying $patchKey auth to $sourceKey",
  async ({ sourceKey, patchKey, canonicalKey }) => {
    await withOpenClawTestState({ label: "provider-auth-canonical" }, async (state) => {
      const provider: ModelProviderConfig = {
        baseUrl: "http://127.0.0.1:4000/v1",
        api: "openai-completions",
        headers: { "x-provider": "keep-provider-header" },
        request: {
          allowPrivateNetwork: true,
          headers: { "x-route": "keep-request-header" },
        },
        models: [
          buildCatalogModel("local-qwen", {
            name: "Configured local model",
            contextWindow: 8192,
            maxTokens: 2048,
            headers: { "x-model": "keep-model-header" },
            params: { temperature: 0.2 },
          }),
          buildCatalogModel("retained-model", {
            name: "Retained model",
            contextWindow: 8192,
            maxTokens: 2048,
          }),
        ],
      };
      await state.writeConfig(configForProviders({ [sourceKey]: provider }));
      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);

      await writeProviderAuthConfig({
        config: snapshot.config,
        configSnapshot: snapshot,
        configPatch: configForProviders({
          [patchKey]: {
            baseUrl: "https://proxy.example.test/v1",
            models: [{ id: "local-qwen", name: "Selected local model" }],
          },
        }),
        credentialsSaved: false,
      });

      const saved: OpenClawConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
      expect(saved.models?.providers).toEqual({
        [canonicalKey]: {
          ...provider,
          baseUrl: "https://proxy.example.test/v1",
          models: [{ ...provider.models[0], name: "Selected local model" }, provider.models[1]],
        },
      });
    });
  },
);
