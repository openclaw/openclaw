import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { cloneFirstTemplateModel, matchesExactOrPrefix } from "./provider-model-helpers.js";
import type { ProviderResolveDynamicModelContext, ProviderRuntimeModel } from "./types.js";

function createContext(models: ProviderRuntimeModel[]): ProviderResolveDynamicModelContext {
  return {
    provider: "test-provider",
    modelId: "next-model",
    modelRegistry: {
      find(providerId: string, modelId: string) {
        return (
          models.find((model) => model.provider === providerId && model.id === modelId) ?? null
        );
      },
    } as ModelRegistry,
  };
}

describe("cloneFirstTemplateModel", () => {
  it("clones the first matching template and applies patches", () => {
    const model = cloneFirstTemplateModel({
      providerId: "test-provider",
      modelId: " next-model ",
      templateIds: ["missing", "template-a", "template-b"],
      ctx: createContext([
        {
          id: "template-a",
          name: "Template A",
          provider: "test-provider",
          api: "openai-completions",
        } as ProviderRuntimeModel,
      ]),
      patch: { reasoning: true },
    });

    expect(model).toMatchObject({
      id: "next-model",
      name: "next-model",
      provider: "test-provider",
      api: "openai-completions",
      reasoning: true,
    });
  });

  it("returns undefined when no template exists", () => {
    const model = cloneFirstTemplateModel({
      providerId: "test-provider",
      modelId: "next-model",
      templateIds: ["missing"],
      ctx: createContext([]),
    });

    expect(model).toBeUndefined();
  });
});

describe("matchesExactOrPrefix", () => {
  it("matches exact ids and prefixed variants case-insensitively", () => {
    expect(matchesExactOrPrefix("MiniMax-M2.7", ["minimax-m2.7"])).toBe(true);
    expect(matchesExactOrPrefix("minimax-m2.7-highspeed", ["MiniMax-M2.7"])).toBe(true);
    expect(matchesExactOrPrefix("glm-5", ["minimax-m2.7"])).toBe(false);
  });
});
