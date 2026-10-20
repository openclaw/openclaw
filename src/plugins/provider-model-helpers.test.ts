import type { ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it, vi } from "vitest";
import {
  cloneFirstTemplateModel,
  matchesExactOrPrefix,
  resolveFamilyForwardCompatModel,
} from "./provider-model-helpers.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type { ProviderResolveDynamicModelContext } from "./types.js";

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

function createTemplateModel(
  id: string,
  overrides: Partial<ProviderRuntimeModel> = {},
): ProviderRuntimeModel {
  return {
    id,
    name: id,
    provider: "test-provider",
    api: "openai-completions",
    ...overrides,
  } as ProviderRuntimeModel;
}

it.each([
  {
    name: "clones the first matching template and applies patches",
    params: {
      modelId: " next-model ",
      templateIds: ["missing", "template-a", "template-b"],
      ctx: createContext([createTemplateModel("template-a", { name: "Template A" })]),
      patch: { reasoning: true },
    },
    expected: createTemplateModel("next-model", { reasoning: true }),
  },
  {
    name: "normalizes the patched transport",
    params: {
      templateIds: ["template-a"],
      ctx: createContext([createTemplateModel("template-a")]),
      patch: { api: "anthropic-messages", baseUrl: "https://models.example/v1" },
    },
    expected: createTemplateModel("next-model", {
      api: "anthropic-messages",
      baseUrl: "https://models.example",
    }),
  },
  {
    name: "returns undefined when no template exists",
    params: {
      templateIds: ["missing"],
      ctx: createContext([]),
    },
    expected: undefined,
  },
] as const)("cloneFirstTemplateModel: $name", ({ params, expected }) => {
  expect(
    cloneFirstTemplateModel({
      providerId: "test-provider",
      modelId: "next-model",
      ...params,
    }),
  ).toEqual(expected);
});

it.each([
  ["MiniMax-M2.7", "minimax-m2.7", true],
  ["minimax-m2.7-highspeed", "MiniMax-M2.7", true],
  ["glm-5", "minimax-m2.7", false],
] as const)("matchesExactOrPrefix: %s against prefix %s: %s", (id, candidate, expected) => {
  expect(matchesExactOrPrefix(id, [candidate])).toBe(expected);
});

describe("resolveFamilyForwardCompatModel", () => {
  it("selects the first matching family and ordered cross-provider template", () => {
    const ctx = createContext([
      createTemplateModel("template-b", { provider: "template-provider", reasoning: false }),
    ]);

    expect(
      resolveFamilyForwardCompatModel({
        providerId: "test-provider",
        ctx,
        cases: [
          {
            match: (id) => id.startsWith("next-"),
            templateSources: [
              { templateIds: ["missing"] },
              { providerId: "template-provider", templateIds: ["template-b"] },
            ],
            patch: { provider: "test-provider", reasoning: true },
          },
        ],
      }),
    ).toMatchObject({
      id: "next-model",
      name: "next-model",
      provider: "test-provider",
      reasoning: true,
    });
  });

  it.each(["template", "synthetic"] as const)(
    "normalizes the constructed %s model after applying its family patch",
    (source) => {
      const template = createTemplateModel("template-a");
      const model = resolveFamilyForwardCompatModel({
        providerId: "test-provider",
        ctx: createContext(source === "template" ? [template] : []),
        cases: [
          {
            match: (id) => id === "next-model",
            templateIds: ["template-a"],
            patch: ({ normalizedModelId }) => ({
              api: "anthropic-messages",
              provider: "test-provider",
              baseUrl: "https://models.example/v1/",
              reasoning: normalizedModelId === "next-model",
            }),
          },
        ],
        synthesize: true,
      });
      expect(model).toMatchObject({
        id: "next-model",
        name: "next-model",
        provider: "test-provider",
        api: "anthropic-messages",
        baseUrl: "https://models.example",
        reasoning: true,
      });
      expect(template.api).toBe("openai-completions");
      expect(template.baseUrl).toBeUndefined();
    },
  );

  it.each([true, false])(
    "preserves exact existing rows only after a family matches (%s)",
    (matches) => {
      const existing = createTemplateModel("next-model", {
        api: "anthropic-messages",
        baseUrl: "https://models.example/v1",
      });
      const patch = vi.fn(() => ({ name: "must-not-replace-existing" }));
      const model = resolveFamilyForwardCompatModel({
        providerId: "test-provider",
        ctx: createContext([existing]),
        cases: [{ match: () => matches, patch }],
        preserveExisting: true,
        synthesize: true,
      });
      expect(model).toBe(matches ? existing : undefined);
      expect(existing.baseUrl).toBe("https://models.example/v1");
      expect(patch).not.toHaveBeenCalled();
    },
  );
});
