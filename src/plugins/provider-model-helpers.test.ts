import type { ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { expect, it, vi } from "vitest";
import {
  cloneFirstTemplateModel,
  matchesExactOrPrefix,
  resolveFamilyForwardCompatModel,
} from "./provider-model-helpers.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type { ProviderResolveDynamicModelContext } from "./types.js";

const provider = "test-provider";
const modelId = "next-model";
const identity = { id: modelId, name: modelId, provider };

function template(id: string, patch: Partial<ProviderRuntimeModel> = {}): ProviderRuntimeModel {
  return { id, name: id, provider, api: "openai-completions", ...patch } as ProviderRuntimeModel;
}

function context(models: ProviderRuntimeModel[]): ProviderResolveDynamicModelContext {
  return {
    provider,
    modelId,
    modelRegistry: {
      find: (owner: string, id: string) =>
        models.find((model) => model.provider === owner && model.id === id) ?? null,
    } as ModelRegistry,
  };
}

type CloneParams = Parameters<typeof cloneFirstTemplateModel>[0];
function clone(params: Partial<CloneParams>, models = [template("template-a")]) {
  return cloneFirstTemplateModel({
    providerId: provider,
    modelId,
    templateIds: ["template-a"],
    ctx: context(models),
    ...params,
  });
}

it("clones the first matching template and applies patches", () => {
  const model = clone(
    {
      modelId: " next-model ",
      templateIds: ["missing", "template-a", "template-b"],
      patch: { reasoning: true },
    },
    [template("template-a", { name: "Template A" })],
  );
  expect(model).toEqual(template(modelId, { reasoning: true }));
});

it("normalizes the patched transport", () => {
  const model = clone({
    patch: { api: "anthropic-messages", baseUrl: "https://models.example/v1" },
  });
  expect(model).toEqual(
    template(modelId, {
      api: "anthropic-messages",
      baseUrl: "https://models.example",
    }),
  );
});

it("returns undefined when no template exists", () => {
  expect(clone({ templateIds: ["missing"] }, [])).toBeUndefined();
});

it.each([
  ["MiniMax-M2.7", "minimax-m2.7", true],
  ["minimax-m2.7-highspeed", "MiniMax-M2.7", true],
  ["glm-5", "minimax-m2.7", false],
] as const)("matchesExactOrPrefix: %s against prefix %s: %s", (id, candidate, expected) => {
  expect(matchesExactOrPrefix(id, [candidate])).toBe(expected);
});

type FamilyParams = Parameters<typeof resolveFamilyForwardCompatModel>[0];
function family(
  models: ProviderRuntimeModel[],
  entry: FamilyParams["cases"][number],
  options: Pick<FamilyParams, "preserveExisting" | "synthesize"> = {},
) {
  return resolveFamilyForwardCompatModel({
    providerId: provider,
    ctx: context(models),
    cases: [entry],
    ...options,
  });
}

it("selects the first matching family and ordered cross-provider template", () => {
  const models = [template("template-b", { provider: "template-provider", reasoning: false })];
  expect(
    family(models, {
      match: (id) => id.startsWith("next-"),
      templateSources: [
        { templateIds: ["missing"] },
        { providerId: "template-provider", templateIds: ["template-b"] },
      ],
      patch: { provider, reasoning: true },
    }),
  ).toMatchObject({ ...identity, reasoning: true });
});

it.each(["template", "synthetic"] as const)(
  "normalizes the constructed %s model after applying its family patch",
  (source) => {
    const original = template("template-a");
    const entry: FamilyParams["cases"][number] = {
      match: (id) => id === modelId,
      templateIds: ["template-a"],
      patch: ({ normalizedModelId }) => ({
        api: "anthropic-messages",
        provider,
        baseUrl: "https://models.example/v1/",
        reasoning: normalizedModelId === modelId,
      }),
    };
    const model = family(source === "template" ? [original] : [], entry, { synthesize: true });
    expect(model).toMatchObject({
      ...identity,
      api: "anthropic-messages",
      baseUrl: "https://models.example",
      reasoning: true,
    });
    expect([original.api, original.baseUrl]).toEqual(["openai-completions", undefined]);
  },
);

it.each([true, false])("preserves existing rows only after a family matches (%s)", (matches) => {
  const existing = template(modelId, {
    api: "anthropic-messages",
    baseUrl: "https://models.example/v1",
  });
  const patch = vi.fn(() => ({ name: "must-not-replace-existing" }));
  const entry = { match: () => matches, patch };
  const model = family([existing], entry, { preserveExisting: true, synthesize: true });
  expect(model).toBe(matches ? existing : undefined);
  expect(existing.baseUrl).toBe("https://models.example/v1");
  expect(patch).not.toHaveBeenCalled();
});
