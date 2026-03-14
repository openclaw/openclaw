import { describe, expect, it } from "vitest";
import { resolveModelFromRegistry } from "./media-tool-shared.js";

const STALE_CODEX_MODEL = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  provider: "openai-codex",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  input: ["text", "image"],
  reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_050_000,
  maxTokens: 128_000,
} as const;

describe("resolveModelFromRegistry", () => {
  it("normalizes stale openai-codex transport/baseUrl pairs", () => {
    const model = resolveModelFromRegistry({
      modelRegistry: {
        find: () => ({ ...STALE_CODEX_MODEL }),
      },
      provider: "openai-codex",
      modelId: "gpt-5.4",
    });

    expect(model).toMatchObject({
      provider: "openai-codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    });
  });

  it("keeps custom openai-codex proxy endpoints unchanged", () => {
    const model = resolveModelFromRegistry({
      modelRegistry: {
        find: () => ({
          ...STALE_CODEX_MODEL,
          baseUrl: "https://proxy.example.com/v1",
        }),
      },
      provider: "openai-codex",
      modelId: "gpt-5.4",
    });

    expect(model).toMatchObject({
      provider: "openai-codex",
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
    });
  });
});
