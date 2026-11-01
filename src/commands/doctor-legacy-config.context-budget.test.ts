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

function expectStable(result: ReturnType<typeof normalizeConfig>, migrate = normalizeConfig) {
  const expected = structuredClone(result.config);
  const repeated = migrate(result.config);
  expect(repeated.config).toEqual(expected);
  expect(repeated.changes).toEqual([]);
}
useDoctorLegacyConfigFixture();

it("migrates legacy Ollama siblings without pinning a current model", () => {
  const current = {
    id: "current",
    api: "ollama",
    contextWindow: 262_144,
    contextTokens: 32_768,
    params: { temperature: 0.2 },
  };
  const result = normalizeConfig(
    ollamaConfig(
      [
        current,
        { id: "legacy", contextWindow: 65_536, params: { temperature: 0.2 } },
        { id: "legacy-inherited", contextWindow: undefined, maxTokens: undefined },
        { id: "pinned", contextWindow: 32768, maxTokens: 4096, params: { num_ctx: 16384 } },
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
  expect(provider?.models?.[0]).toEqual(current);
  expect(provider?.models?.[1]?.params).toEqual({ temperature: 0.2, num_ctx: 65_536 });
  expect(provider?.models?.[2]?.params).toEqual({ num_ctx: 8192 });
  expect(provider?.models?.[3]?.params).toEqual({ num_ctx: 16384 });
  expect(provider?.models?.[4]?.params).toEqual({ temperature: 0.1 });
  expectStable(result);
});

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

it("uses the output budget when the native model window is invalid", () => {
  const res = normalizeConfig(ollamaConfig([{ contextWindow: 0, maxTokens: 24576 }]));
  expect(res.config.models?.providers?.ollama?.models?.[0]?.params).toEqual({ num_ctx: 24576 });
});

it.each([
  ["inherited window", { contextWindow: undefined, maxTokens: 4096 }, undefined, 65536],
  ["explicit model window", { contextWindow: 32768 }, undefined, 32768],
  [
    "existing provider pin",
    { contextWindow: undefined, maxTokens: undefined },
    { num_ctx: 32768 },
    65536,
  ],
] as const)("migrates retired provider contextWindow: %s", (_label, model, params, numCtx) => {
  const models = [model];
  const expectedProviderParams = structuredClone(params);
  const res = migrateConfig(ollamaConfig(models, { contextWindow: 65536, params }));
  const provider = res.config.models?.providers?.ollama;
  expect(provider).not.toHaveProperty("contextWindow");
  expect(provider?.params).toEqual(expectedProviderParams);
  expect(provider?.models?.map((entry) => entry.params)).toEqual(
    numCtx ? [{ num_ctx: numCtx }] : [],
  );
  expect(res.config.agents?.defaults?.model).toEqual({ primary: "ollama/llama3.3" });
  expect(res.warnings).toEqual([]);
});

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
    } else {
      expect(res.config).toEqual(input);
      expect(res.changes).toEqual([]);
    }
  },
);
