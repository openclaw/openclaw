import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { finalizePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import * as modelConfigHelpers from "./model-config.helpers.js";
import { resolvePdfModelConfigForTool } from "./pdf-tool.model-config.js";

const available = new Set<string>();
const activeModel = {
  provider: "openrouter",
  model: "deepseek/deepseek-v4.1-flash",
  supportsImages: true,
};
const resolve = (cfg: OpenClawConfig, active?: typeof activeModel) =>
  resolvePdfModelConfigForTool({
    cfg,
    agentDir: "/tmp/openclaw-pdf-model-config",
    activeModel: active,
  });

function configuredProvider(
  provider: string,
  primary: string,
  modelId?: string,
  input: ("text" | "image")[] = ["text"],
): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary } } },
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://example.com/v1",
          models: modelId
            ? [
                {
                  id: modelId,
                  name: modelId,
                  reasoning: false,
                  input,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32_000,
                  maxTokens: 4_096,
                },
              ]
            : [],
        },
      },
    },
  };
}

beforeEach(() => {
  available.clear();
  vi.spyOn(modelConfigHelpers, "hasProviderAuthForTool").mockImplementation(({ provider }) =>
    available.has(provider),
  );
});
afterEach(() => vi.restoreAllMocks());

it.each([
  [true, true, { primary: "openrouter/deepseek/deepseek-v4.1-flash" }],
  [false, true, null],
  [true, false, null],
] as const)(
  "requires active fallback auth=%s and image support=%s",
  (auth, supportsImages, expected) => {
    if (auth) {
      available.add("openrouter");
    }
    expect(
      resolve(configuredProvider("openrouter", "anthropic/claude-sonnet-4-5"), {
        ...activeModel,
        supportsImages,
      }),
    ).toEqual(expected);
  },
);

it("does not select a provider that disables PDF image extraction", () => {
  available.add("restricted");
  const cfg = configuredProvider("restricted", "restricted/text");
  const snapshot = finalizePluginMetadataSnapshot(
    createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "restricted",
          contracts: { mediaUnderstandingProviders: ["restricted"] },
          mediaUnderstandingProviderMetadata: {
            restricted: { capabilities: ["image"], documentModels: { pdf: { image: false } } },
          },
        },
      ],
    }),
  );
  withPluginMetadataSnapshotScope(
    snapshot,
    () => {
      expect(
        resolve(cfg, { provider: "restricted", model: "vision", supportsImages: true }),
      ).toBeNull();
    },
    { config: cfg, trustConfigIdentity: true },
  );
});

it("prefers the native PDF default over the active fallback", () => {
  available.add("anthropic");
  available.add("openrouter");
  expect(
    resolve(configuredProvider("openrouter", "anthropic/claude-opus-5"), activeModel)?.primary,
  ).toBe("anthropic/claude-opus-5-5");
});

it("falls back to explicit imageModel config", () => {
  expect(
    resolve({
      agents: { defaults: { imageModel: { primary: "openai/gpt-5.4-mini" } } },
    }),
  ).toEqual({ primary: "openai/gpt-5.4-mini" });
});

it.each([
  {
    provider: "Minimax",
    primary: "openai/gpt-5.4",
    model: "MiniMax-M2.7-highspeed",
    expected: {
      primary: "minimax/MiniMax-M2.7-highspeed",
      fallbacks: ["minimax-portal/MiniMax-M2.7"],
    },
  },
  {
    provider: "minimax",
    primary: "minimax/MiniMax-VL-01",
    model: undefined,
    expected: { primary: "minimax/MiniMax-M2.7", fallbacks: ["minimax-portal/MiniMax-M2.7"] },
  },
  {
    provider: "minimax-portal",
    primary: "minimax-portal/MiniMax-M2.7",
    model: undefined,
    expected: { primary: "minimax-portal/MiniMax-M2.7", fallbacks: ["minimax/MiniMax-M2.7"] },
  },
])("selects a text-extraction model for $primary", ({ provider, primary, model, expected }) => {
  available.add("minimax");
  available.add("minimax-portal");
  expect(resolve(configuredProvider(provider, primary, model))).toEqual(expected);
});

it("uses an authenticated custom provider's configured vision model", () => {
  available.add("hatchery");
  expect(
    resolve(configuredProvider("hatchery", "hatchery/text-1", "vision-1", ["text", "image"])),
  ).toEqual({ primary: "hatchery/vision-1" });
});
