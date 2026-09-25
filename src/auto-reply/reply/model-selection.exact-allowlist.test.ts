import { expect, test, vi } from "vitest";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";
import { createModelSelectionState } from "./model-selection.js";

vi.mock("../../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
}));

const PROVIDER = "chutes";
const ALLOWLISTED = "chutes/deepseek-ai/DeepSeek-V3.2-TEE";

const configuredModel = (overrides: Record<string, unknown> = {}) => ({
  id: "gpt-5.4",
  name: "GPT-5.4",
  reasoning: true,
  input: ["text"] as Array<"text">,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
  ...overrides,
});

const configuredModelIds = [
  "deepseek-ai/DeepSeek-V3.2-TEE",
  "zai-org/GLM-5.2-TEE",
  "google/gemma-4-31B-turbo-TEE",
];

/**
 * `agents.defaults.models` is an exact allowlist and `defaultModel` is the model
 * id of the resolved provider/model pair, so ids that contain a slash (normal for
 * Chutes/OpenRouter-style providers) must survive resolution as the configured
 * default instead of being replaced by the allowlist's first entry.
 */
test.each([
  ["zai-org/GLM-5.2-TEE", "chutes/zai-org/GLM-5.2-TEE"],
  ["google/gemma-4-31B-turbo-TEE", "chutes/google/gemma-4-31B-turbo-TEE"],
] as const)(
  "keeps the configured primary %s under an exact allowlist that omits it",
  async (defaultModel, configuredPrimary) => {
    await withStateDirEnv("reply-exact-allowlist-", async () => {
      const cfg = {
        agents: {
          defaults: { models: { [ALLOWLISTED]: {} } },
          entries: { athena: { model: { primary: configuredPrimary } } },
        },
        models: {
          providers: {
            [PROVIDER]: {
              api: "openai-completions",
              baseUrl: "https://chutes.invalid/v1",
              models: configuredModelIds.map((id) =>
                configuredModel({ id, name: id, reasoning: true }),
              ),
            },
          },
        },
      } as OpenClawConfig;
      const entries = configuredModelIds.map((id) => ({
        provider: PROVIDER,
        id,
        name: id,
      }));
      const preparedModelCatalog: ModelCatalogSnapshot = {
        entries,
        routeVariants: entries,
        authoritative: true,
      };

      const state = await createModelSelectionState({
        cfg,
        agentId: "athena",
        agentCfg: cfg.agents?.defaults,
        defaultProvider: PROVIDER,
        defaultModel,
        provider: PROVIDER,
        model: defaultModel,
        hasModelDirective: false,
        preparedModelCatalog,
      });

      expect(state.provider).toBe(PROVIDER);
      expect(state.model).toBe(defaultModel);
    });
  },
);
