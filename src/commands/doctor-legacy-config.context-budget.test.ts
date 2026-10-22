// Load the shared migration mocks before their production consumers.
// oxfmt-ignore
import { useDoctorLegacyConfigFixture } from "./doctor/shared/legacy-config-fixture.test-support.js";
import { expect, it } from "vitest";
import { applyLegacyDoctorMigrations } from "./doctor/shared/legacy-config-compat.js";
import { normalizeCompatibilityConfigValues as normalizeConfig } from "./doctor/shared/legacy-config-core-migrate.js";

function migrateConfig(config: unknown) {
  const early = applyLegacyDoctorMigrations(config, { sourceConfigBeforeMigrations: config });
  const normalized = normalizeConfig(early.next ?? config);
  return {
    ...normalized,
    changes: [...early.changes, ...normalized.changes],
    warnings: [...(early.warnings ?? []), ...(normalized.warnings ?? [])],
  };
}

function ollamaConfig(
  models: Record<string, unknown>[],
  provider: Record<string, unknown> = {},
  id = "ollama",
) {
  const nextProvider = {
    baseUrl: "http://localhost:11434",
    api: "ollama",
    ...provider,
    models: models.map((model) => ({ id: "llama3.3", ...model })),
  };
  return { models: { providers: { [id]: nextProvider } } };
}

const bakedWindow =
  "models.providers.ollama.contextWindow → models.providers.ollama.models[0].contextWindow.";
const removedWindow =
  "Removed models.providers.ollama.contextWindow after baking it into explicit model entries.";
const preservedPrimary =
  "Preserved the implicit primary model in agents.defaults.model.primary (ollama/llama3.3).";
const pinChange = (numCtx: number, id = "ollama") =>
  `Set models.providers.${id}.models[0].params.num_ctx to ${numCtx} for native Ollama compatibility.`;
function expectStable(result: ReturnType<typeof normalizeConfig>, migrate = normalizeConfig) {
  const expected = structuredClone(result.config);
  const repeated = migrate(result.config);
  expect(repeated.config).toEqual(expected);
  expect(repeated.changes).toEqual([]);
}
useDoctorLegacyConfigFixture();

it.each([
  ["provider output budget", {}, {}],
  ["explicit provider num_ctx", { params: { num_ctx: 16_384 } }, {}],
  ["explicit model num_ctx", {}, { params: { num_ctx: 16_384 } }],
] as const)("preserves current Ollama contextTokens with %s", (_label, provider, model) => {
  const input = ollamaConfig(
    [{ contextWindow: 262_144, contextTokens: 32_768, ...model }],
    { maxTokens: 8192, ...provider },
    "localOllama",
  );
  const expected = structuredClone(input);
  const result = normalizeConfig(input);
  expect(result.config).toEqual(expected);
  expect(result.changes).toEqual([]);
  expectStable(result);
});

it.each(["ollama", "openai-completions"] as const)(
  "migrates legacy Ollama siblings without pinning a current %s model",
  (api) => {
    const result = normalizeConfig(
      ollamaConfig(
        [
          {
            id: "current",
            api,
            contextWindow: 262_144,
            contextTokens: 32_768,
            params: { temperature: 0.2 },
          },
          { id: "legacy", contextWindow: 65_536 },
          { id: "legacy-inherited", contextWindow: undefined, maxTokens: undefined },
          {
            id: "compatible",
            api: "openai-completions",
            contextWindow: 81920,
            params: { temperature: 0.1 },
          },
        ],
        { maxTokens: 8192 },
        "localOllama",
      ),
    );
    const provider = result.config.models?.providers?.localOllama;
    expect(provider?.params).toBeUndefined();
    expect(provider?.models?.[0]).toMatchObject({
      id: "current",
      api,
      contextWindow: 262_144,
      contextTokens: 32_768,
      params: { temperature: 0.2 },
    });
    expect(provider?.models?.[0]?.params).not.toHaveProperty("num_ctx");
    expect(provider?.models?.[1]?.params).toEqual({ num_ctx: 65_536 });
    expect(provider?.models?.[2]?.params).toEqual({ num_ctx: 8192 });
    expect(provider?.models?.[3]?.params).toEqual({ temperature: 0.1 });
    expectStable(result);
  },
);

it("keeps retired provider contextTokens usable without adding an Ollama num_ctx pin", () => {
  const result = migrateConfig(
    ollamaConfig([{ contextWindow: undefined }], {
      contextTokens: 32_768,
      contextWindow: 262_144,
      maxTokens: 8192,
    }),
  );
  const provider = result.config.models?.providers?.ollama;
  expect(provider).not.toHaveProperty("contextTokens");
  expect(provider).not.toHaveProperty("contextWindow");
  expect(provider?.params).toBeUndefined();
  expect(provider?.models?.[0]).toMatchObject({ contextTokens: 32_768, contextWindow: 262_144 });
  expect(provider?.models?.[0]?.params).toBeUndefined();
  expectStable(result, migrateConfig);
});

it.each([
  [
    "ollama",
    [
      { contextWindow: 81920, params: { temperature: 0.2 } },
      { id: "llama3.3-small", contextWindow: 32768, maxTokens: 4096, params: { num_ctx: 16384 } },
    ],
    [{ temperature: 0.2, num_ctx: 81920 }, { num_ctx: 16384 }],
    81920,
  ],
  ["localOllama", [{ contextWindow: 0, maxTokens: 24576 }], [{ num_ctx: 24576 }], 24576],
] as const)("sets native %s model budget params", (id, models, params, numCtx) => {
  const res = normalizeConfig(ollamaConfig([...models], {}, id));
  expect(res.config.models?.providers?.[id]?.models?.map((model) => model.params)).toEqual(params);
  expect(res.changes).toEqual([pinChange(numCtx, id)]);
});

it.each([
  ["inherited window", { contextWindow: undefined, maxTokens: 4096 }, undefined, 65536, true],
  ["explicit model window", { contextWindow: 32768 }, undefined, 32768, false],
  [
    "existing provider pin",
    { contextWindow: undefined, maxTokens: undefined },
    { num_ctx: 32768 },
    65536,
    true,
  ],
  ["no explicit models", undefined, undefined, undefined, false],
] as const)(
  "migrates retired provider contextWindow: %s",
  (_label, model, params, numCtx, baked) => {
    const models = model ? [model] : [];
    const expectedProviderParams = structuredClone(params);
    const res = migrateConfig(ollamaConfig(models, { contextWindow: 65536, params }));
    const provider = res.config.models?.providers?.ollama;
    expect(provider).not.toHaveProperty("contextWindow");
    expect(provider?.params).toEqual(expectedProviderParams);
    expect(provider?.models?.map((entry) => entry.params)).toEqual(
      numCtx ? [{ num_ctx: numCtx }] : [],
    );
    if (models.length) {
      expect(res.config.agents?.defaults?.model).toEqual({ primary: "ollama/llama3.3" });
    }
    expect(res.changes).toEqual(
      numCtx
        ? [...(baked ? [bakedWindow] : []), removedWindow, preservedPrimary, pinChange(numCtx)]
        : ["Removed models.providers.ollama.contextWindow."],
    );
    expect(res.warnings).toEqual(
      model
        ? []
        : [
            "models.providers.ollama.contextWindow had no explicit model entries to receive its value; use models.providers.<provider>.models[].contextTokens instead.",
          ],
    );
  },
);

it("keeps native Ollama params prototype-safe while setting num_ctx", () => {
  const ownProto = (params: Record<string, unknown>, value: Record<string, unknown>) =>
    Object.defineProperty(params, "__proto__", { enumerable: true, value });
  const providerParams = ownProto({ temperature: 0.2 }, { think: "high" });
  const modelParams = ownProto({ top_p: 0.9 }, { keep_alive: "forever" });
  const res = migrateConfig(
    ollamaConfig([{ contextWindow: 32768, params: modelParams }], {
      contextWindow: 65536,
      params: providerParams,
    }),
  );
  const provider = res.config.models?.providers?.ollama;
  for (const [params, proto, leaked, numCtx] of [
    [provider?.params, { think: "high" }, "think", undefined],
    [provider?.models?.[0]?.params, { keep_alive: "forever" }, "keep_alive", 32768],
  ] as const) {
    expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(params, "__proto__")?.value).toEqual(proto);
    expect(params?.[leaked]).toBeUndefined();
    expect(params?.num_ctx).toBe(numCtx);
  }
});

it.each([false, true])(
  "does not pin OpenAI-compatible Ollama configs (implicit=%s)",
  (implicit) => {
    const input = ollamaConfig([{ contextWindow: 81920 }], {
      baseUrl: "http://localhost:11434/v1",
      api: implicit ? undefined : "openai-completions",
      ...(implicit ? { contextWindow: 65536 } : {}),
    });
    const res = implicit ? migrateConfig(input) : normalizeConfig(input);
    if (implicit) {
      expect(res.config.models?.providers?.ollama).not.toHaveProperty("contextWindow");
      expect(res.config.models?.providers?.ollama?.models).toEqual(
        input.models?.providers?.ollama?.models,
      );
      expect(res.config.agents?.defaults?.model).toEqual({ primary: "ollama/llama3.3" });
      expect(res.changes).toEqual([removedWindow, preservedPrimary]);
    } else {
      expect(res.config).toEqual(input);
      expect(res.changes).toEqual([]);
    }
  },
);
