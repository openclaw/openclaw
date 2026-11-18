/** Complete provider model fixtures with typed scenario overrides. */
import type { Api, Model } from "openclaw/plugin-sdk/llm";

type FixtureModel<TApi extends Api> = Omit<Model<TApi>, "headers"> & {
  headers?: Record<string, string>;
};

type ProviderModelFixture<TApi extends Api> = Partial<
  Omit<Model<TApi>, "id" | "provider" | "api" | "baseUrl">
> &
  Pick<Model<TApi>, "id" | "provider" | "baseUrl"> & {
    /** Transport aliases intentionally exercise normalization before the canonical API is restored. */
    api: string;
    /** Guarded transport accepts this provider metadata extension before SDK normalization. */
    requestTimeoutMs?: number;
  };

export function makeProviderModelFixture<TApi extends Api>(
  overrides: ProviderModelFixture<TApi> & { headers?: Record<string, string> },
): FixtureModel<TApi>;
export function makeProviderModelFixture<TApi extends Api>(
  overrides: ProviderModelFixture<TApi>,
): Model<TApi>;
export function makeProviderModelFixture<TApi extends Api>(
  overrides: ProviderModelFixture<TApi>,
): Model<TApi> {
  return {
    name: overrides.id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_000,
    maxTokens: 4_096,
    ...overrides,
    api: overrides.api as TApi,
  };
}

export function makeProviderModelsConfigFixture<TApi extends Api>(
  overrides: ProviderModelFixture<TApi> & { headers?: Record<string, string> },
) {
  return {
    providers: {
      [overrides.provider]: {
        baseUrl: overrides.baseUrl,
        models: [makeProviderModelFixture(overrides)],
      },
    },
  };
}

export const makeConfiguredModel = (overrides: Record<string, unknown> = {}) => ({
  id: "gpt-5.4",
  name: "GPT-5.4",
  reasoning: true,
  input: ["text"] as Array<"text">,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_384,
  ...overrides,
});
