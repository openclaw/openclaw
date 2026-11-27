import type { ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { expect, it } from "vitest";
import {
  cloneFirstTemplateModel,
  matchesExactOrPrefix,
  resolveFamilyForwardCompatModel,
} from "../plugin-sdk/provider-model-shared.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";

const provider = "test-provider";
const modelId = "next-model";
const identity = { id: modelId, name: modelId, provider };

function template(id: string, patch: Partial<ProviderRuntimeModel> = {}): ProviderRuntimeModel {
  return { id, name: id, provider, api: "openai-completions", ...patch } as ProviderRuntimeModel;
}

function input(models: ProviderRuntimeModel[]) {
  return {
    providerId: provider,
    modelId,
    ctx: {
      provider,
      modelId,
      modelRegistry: {
        find: (owner: string, id: string) =>
          models.find((model) => model.provider === owner && model.id === id) ?? null,
      } as ModelRegistry,
    },
  };
}
const transport = { api: "anthropic-messages", baseUrl: "https://models.example" } as const;

it.each([false, true])("clones and normalizes the first available template (found=%s)", (found) => {
  const original = template("template-a", { name: "Template A" });
  const model = cloneFirstTemplateModel({
    ...input(found ? [original] : []),
    modelId: " next-model ",
    templateIds: ["missing", "template-a", "template-b"],
    patch: { reasoning: true, ...transport, baseUrl: transport.baseUrl + "/v1" },
  });
  expect(model).toEqual(found ? template(modelId, { ...transport, reasoning: true }) : undefined);
  expect([original.api, original.baseUrl]).toEqual(["openai-completions", undefined]);
});

it.each([
  ["MiniMax-M2.7", "minimax-m2.7", true],
  ["minimax-m2.7-highspeed", "MiniMax-M2.7", true],
  ["glm-5", "minimax-m2.7", false],
] as const)("matchesExactOrPrefix: %s against prefix %s: %s", (id, candidate, expected) => {
  expect(matchesExactOrPrefix(id, [candidate])).toBe(expected);
});

it.each([false, true])("normalizes a family model with a cross-provider template=%s", (found) => {
  const patch = { ...transport, provider, baseUrl: transport.baseUrl + "/v1/", reasoning: true };
  const model = resolveFamilyForwardCompatModel({
    ...input(
      found ? [template("template-b", { provider: "template-provider", reasoning: false })] : [],
    ),
    cases: [
      {
        match: (id) => id === modelId,
        templateSources: [
          { templateIds: ["missing"] },
          { providerId: "template-provider", templateIds: ["template-b"] },
        ],
        patch: found
          ? patch
          : ({ normalizedModelId }) => ({ ...patch, reasoning: normalizedModelId === modelId }),
      },
    ],
    synthesize: !found,
  });
  expect(model).toMatchObject({ ...identity, ...transport, reasoning: true });
});

it.each([true, false])("preserves existing rows only after a family matches (%s)", (matches) => {
  const existing = template(modelId, {
    ...transport,
    baseUrl: transport.baseUrl + "/v1",
  });
  const patch = { name: "must-not-replace-existing" };
  const entry = { match: () => matches, patch };
  const model = resolveFamilyForwardCompatModel({
    ...input([existing]),
    cases: [entry],
    preserveExisting: true,
    synthesize: true,
  });
  expect(model).toBe(matches ? existing : undefined);
  expect(existing.baseUrl).toBe("https://models.example/v1");
});
