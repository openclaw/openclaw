import { expect, it } from "vitest";
import { applyModelDefaults } from "./defaults.js";
import type { OpenClawConfig } from "./types.openclaw.js";

it.each([
  { maxTokens: undefined, contextWindow: undefined, contextTokens: undefined },
  { maxTokens: 256, contextWindow: undefined, contextTokens: 4096 },
  { maxTokens: 512, contextWindow: 1024, contextTokens: 4096 },
])("preserves unknown limits and separate execution choices %j", (limits) => {
  const cfg: OpenClawConfig = {
    models: {
      providers: {
        fixture: {
          api: "anthropic-messages",
          baseUrl: "https://models.example",
          models: [
            {
              id: "unknown",
              name: "Unknown",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              ...limits,
            },
          ],
        },
      },
    },
  };
  const projected = applyModelDefaults(cfg, { manifestRegistry: { plugins: [] } });
  const model = projected.models?.providers?.fixture?.models?.[0];
  expect(model?.maxTokens).toBe(limits.maxTokens);
  expect(model?.contextWindow).toBe(limits.contextWindow);
  expect(model?.contextTokens).toBe(
    limits.contextWindow === undefined ? limits.contextTokens : 1024,
  );
  const storedConfig = JSON.stringify(projected);
  expect(JSON.parse(storedConfig).models.providers.fixture.models[0].contextWindow).toBe(
    limits.contextWindow,
  );
});
it("keeps a provider execution budget without inventing a context window", () => {
  const cfg: OpenClawConfig = {
    models: {
      providers: {
        fixture: {
          api: "anthropic-messages",
          baseUrl: "https://models.example",
          maxTokens: 256,
          models: [
            {
              id: "unknown",
              name: "Unknown",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
  };
  const model = applyModelDefaults(cfg, { manifestRegistry: { plugins: [] } }).models?.providers
    ?.fixture?.models?.[0];
  expect(model).toMatchObject({ maxTokens: 256, contextWindow: undefined });
});
