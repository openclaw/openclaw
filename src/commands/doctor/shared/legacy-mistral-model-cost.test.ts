import { expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../../../config/types.models.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeLegacyMistralModelDefaults } from "./legacy-config-core-normalizers.js";

it.each(["constructor", "__proto__"])("preserves the configured cost of custom model %s", (id) => {
  const model: ModelDefinitionConfig = {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 4096,
  };
  const config: OpenClawConfig = {
    models: {
      providers: {
        mistral: {
          baseUrl: "https://api.mistral.ai/v1",
          api: "openai-completions",
          models: [model],
        },
      },
    },
  };
  const changes: string[] = [];

  normalizeLegacyMistralModelDefaults(config, changes);

  expect(model.cost.cacheRead).toBe(0);
  expect(changes).toEqual([]);
});
