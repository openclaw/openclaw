import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { promptDefaultModel } from "../flows/model-picker.js";
import { WizardCancelledError, type WizardSelectParams } from "../wizard/prompts.js";
import { makePrompter } from "./setup/__tests__/test-utils.js";

const prepared = vi.hoisted(() => ({ catalog: [] as ModelCatalogEntry[] }));
vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalogSnapshot: async () => ({
    entries: prepared.catalog,
    routeVariants: prepared.catalog,
  }),
}));
vi.mock("../agents/model-provider-auth.js", () => ({
  createProviderAuthChecker: () =>
    Object.assign(async () => true, {
      evaluateModelAuth: async () => ({ availability: true, routeResolution: null }),
    }),
}));
vi.mock("../agents/model-runtime-aliases.js", () => ({
  createModelPickerVisibleProviderPredicate: () => () => true,
}));
const selectedHook = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./model-picker.runtime.js", () => ({
  modelPickerRuntime: {
    resolvePluginProviders: () => [],
    runProviderModelSelectedHook: selectedHook,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_LOCALE", "en");
});
afterEach(() => vi.unstubAllEnvs());

function catalog(count: number, provider: (index: number) => string) {
  return Array.from({ length: count }, (_, index) => ({
    provider: provider(index),
    id: `model-${index}`,
    name: `Model ${index}`,
  }));
}
function pick(
  prompter: ReturnType<typeof makePrompter>,
  models: Record<string, { alias: string }> = {},
) {
  return promptDefaultModel({
    config: { agents: { defaults: { model: "zeta/model-0", models } } },
    prompter,
    allowKeep: false,
  });
}

describe("default model provider menu", () => {
  it.each([
    { count: 30, selection: "*", singleProvider: false },
    { count: 31, selection: "*", singleProvider: false },
    { count: 31, selection: "alpha", singleProvider: false },
    { count: 31, selection: "*", singleProvider: true },
  ])(
    "preserves counts and choices for $count models ($selection, single=$singleProvider)",
    async ({ count, selection, singleProvider }) => {
      prepared.catalog = catalog(count, (index) =>
        singleProvider || index < 15 ? "zeta" : index < 30 ? "alpha" : "beta",
      );
      const prompts: WizardSelectParams<unknown>[] = [];
      const prompter = makePrompter({
        select: async (params) => {
          prompts.push(params);
          const choice =
            params.message === "Filter models by provider"
              ? params.options.find((option) => option.value === selection)
              : params.options.find((option) => String(option.value).includes("/"));
          if (!choice) {
            throw new Error("Missing picker choice");
          }
          return choice.value;
        },
      });
      const result = await pick(prompter, { "alpha/model-15": { alias: "compact" } });
      const modelPrompt = count > 30 && !singleProvider ? 1 : 0;
      expect(prompts).toHaveLength(modelPrompt + 1);
      if (modelPrompt === 1) {
        expect(prompts[0]?.options).toEqual([
          { value: "*", label: "All providers" },
          { value: "alpha", label: "alpha", hint: "15 models" },
          { value: "beta", label: "beta", hint: "1 model" },
          { value: "zeta", label: "zeta", hint: "15 models" },
        ]);
      }
      const expected = selection === "alpha" ? prepared.catalog.slice(15, 30) : prepared.catalog;
      const expectedValues = expected.map(({ provider, id }) => `${provider}/${id}`);
      if (selection === "alpha") {
        expectedValues.push("zeta/model-0");
      }
      expect(prompts[modelPrompt]?.options.map((option) => option.value)).toEqual([
        "__manual__",
        ...expectedValues,
      ]);
      if (!singleProvider) {
        expect(
          prompts[modelPrompt]?.options.find((option) => option.value === "alpha/model-15")?.hint,
        ).toContain("alias: compact");
      }
      expect(result).toEqual({ model: expectedValues[0] });
    },
  );

  it("propagates provider-menu cancellation before choosing a model", async () => {
    prepared.catalog = catalog(31, (index) => (index % 2 ? "alpha" : "zeta"));
    const cancellation = new WizardCancelledError();
    const select = vi.fn(async () => {
      throw cancellation;
    });
    await expect(pick(makePrompter({ select }))).rejects.toBe(cancellation);
    expect(select).toHaveBeenCalledTimes(1);
    expect(selectedHook).not.toHaveBeenCalled();
  });
});
