import { normalizeModelCostConfig } from "@openclaw/llm-core";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listAgentIds } from "../agents/agent-roster.js";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import type { ProviderResolveModelRoutesContext } from "../plugin-sdk/provider-model-types.js";
import { resolveProviderModelRoutes } from "../plugins/provider-model-routes.js";
import { estimateUsageCost } from "../utils/usage-format.js";
import {
  DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES,
  DEFAULT_SUBAGENT_MAX_CONCURRENT,
  resolveAgentMaxConcurrent,
} from "./agent-limits.js";
import { attachAgentListProjection } from "./agent-list-projection.js";
import {
  applyAgentDefaults,
  applyContextPruningDefaults,
  applyMessageDefaults,
  applyModelDefaults,
} from "./defaults.js";
import { resolveConfigEnvVars, type EnvSubstitutionWarning } from "./env-substitution.js";
import { materializeRuntimeConfig } from "./materialize.js";
import {
  collectEnvSecretRefIds,
  createConfigResolutionFacts,
  getAuthoredConfigSecretRef,
  getResolvedConfigEnvSecretRef,
  setConfigResolutionFacts,
} from "./resolution-facts.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "./runtime-snapshot.js";
import type { ModelProviderConfig } from "./types.models.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const mocks = vi.hoisted(() => ({
  applyProviderConfigDefaultsForConfig: vi.fn(),
}));

const materialize = (config: OpenClawConfig, env: NodeJS.ProcessEnv = {}) =>
  materializeRuntimeConfig(config, {
    env,
    homedir: () => "/tmp/config-fixture",
    manifestRegistry: { plugins: [] },
  });
const withModels = (
  models: ModelProviderConfig["models"],
  provider = "openai",
  baseUrl = "https://api.openai.com/v1",
): OpenClawConfig => ({ models: { providers: { [provider]: { baseUrl, models } } } });
function materializedModel(
  config: OpenClawConfig,
  manifestRegistry: NonNullable<Parameters<typeof applyModelDefaults>[1]>["manifestRegistry"],
  provider = "openai",
) {
  return expectDefined(
    applyModelDefaults(config, { manifestRegistry }).models?.providers?.[provider]?.models?.[0],
    "materialized model entry",
  );
}
function catalog(providers: Record<string, unknown>, id = "openai") {
  return { plugins: [{ id, modelCatalog: { providers } }] };
}

vi.mock("./provider-policy.js", () => ({
  applyProviderConfigDefaultsForConfig: (
    ...args: Parameters<typeof mocks.applyProviderConfigDefaultsForConfig>
  ) => mocks.applyProviderConfigDefaultsForConfig(...args),
  normalizeProviderConfigForConfigDefaults: vi.fn(
    (_params: { providerConfig: unknown }) => _params.providerConfig,
  ),
}));

describe("config defaults", () => {
  beforeEach(() => {
    mocks.applyProviderConfigDefaultsForConfig.mockReset();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
  });

  it("materializes the canonical main session key and warns only once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = { session: { mainKey: " custom " } };
    try {
      expect(materialize(source).session?.mainKey).toBe("main");
      expect(source.session.mainKey).toBe(" custom ");
      expect(materialize({ session: { mainKey: "another" } }).session?.mainKey).toBe("main");
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'session.mainKey is ignored; main session is always "main".',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("carries only surviving env provenance through materialization", () => {
    const warnings: EnvSubstitutionWarning[] = [];
    const pending = new Map<string, string>();
    const resolved = new Map<string, string>();
    const source = resolveConfigEnvVars(
      {
        logging: { file: "${LOG_PATH}" },
        gateway: { auth: { token: "$PENDING_TOKEN", password: "${KEEP_PASSWORD}" } },
      },
      { LOG_PATH: "~/logs/openclaw.log", KEEP_PASSWORD: "fixture-password" },
      {
        onMissing: (warning) => warnings.push(warning),
        onPendingEnvSecretRef: (id, path) => pending.set(path, id),
        onResolvedEnvSecretRef: (id, path) => resolved.set(path, id),
      },
      // SAFETY: substitution changes only strings in this known config fixture.
    ) as OpenClawConfig;
    setConfigResolutionFacts(
      source,
      createConfigResolutionFacts(warnings, pending, "custom", resolved),
    );

    const runtime = materialize(source);
    const envRef = (id: string) => ({ source: "env", provider: "custom", id });

    expect(runtime.logging?.file).toBe("/tmp/config-fixture/logs/openclaw.log");
    expect(getResolvedConfigEnvSecretRef(runtime, "logging.file")).toBeNull();
    expect(getResolvedConfigEnvSecretRef(runtime, "gateway.auth.password")).toEqual(
      envRef("KEEP_PASSWORD"),
    );
    expect(getAuthoredConfigSecretRef(runtime, "gateway.auth.token")).toEqual(
      envRef("PENDING_TOKEN"),
    );
    expect(collectEnvSecretRefIds(runtime)).toEqual(new Set(["PENDING_TOKEN", "KEEP_PASSWORD"]));
  });

  it("preserves the implicit main agent when materializing a pre-roster config", () => {
    expect(listAgentIds(materialize({}))).toEqual(["main"]);
  });

  it("rebuilds the SDK roster projection from the final materialized entries", () => {
    const source: OpenClawConfig = {
      agents: {
        entries: {
          worker: { model: "google/gemini-3-pro-preview", workspace: "~/worker" },
          helper: { name: "Helper" },
        },
      },
    };
    attachAgentListProjection(source);
    const runtime = materialize(source);
    expect(Object.getOwnPropertyDescriptor(runtime.agents, "list")).toEqual({
      configurable: true,
      enumerable: false,
      writable: false,
      value: [
        {
          id: "worker",
          model: "google/gemini-3.1-pro-preview",
          workspace: "/tmp/config-fixture/worker",
        },
        { id: "helper", name: "Helper" },
      ],
    });
    expect(structuredClone(runtime)).not.toHaveProperty("agents.list");
  });

  it.each([
    { models: { providers: { openai: { api: "openai-completions" } } } },
    { agents: { defaults: {} } },
  ])("skips provider defaults without both agent defaults and an auth signal: %j", (cfg) => {
    expect(applyContextPruningDefaults(cfg as never)).toBe(cfg);
    expect(mocks.applyProviderConfigDefaultsForConfig).not.toHaveBeenCalled();
  });

  it("uses anthropic provider defaults when agent defaults and auth signal exist", () => {
    const cfg: OpenClawConfig = {
      auth: { profiles: { anthropic: { provider: "anthropic", mode: "api_key" } } },
      agents: { defaults: {} },
    };
    const nextCfg = { agents: { defaults: { contextPruning: { mode: "cache-ttl" } } } };
    mocks.applyProviderConfigDefaultsForConfig.mockReturnValue(nextCfg);

    const manifestRegistry = { plugins: [] };
    expect(applyContextPruningDefaults(cfg, { manifestRegistry })).toBe(nextCfg);
    expect(mocks.applyProviderConfigDefaultsForConfig.mock.calls[0]?.[0].manifestRegistry).toBe(
      manifestRegistry,
    );
  });

  it.each(["staged", "ambient"] as const)(
    "materializes provider defaults from the supplied env when auth is %s",
    (source) => {
      vi.stubEnv("ANTHROPIC_API_KEY", source === "ambient" ? "ambient-fixture" : "");
      const env = { ANTHROPIC_API_KEY: source === "staged" ? "staged-fixture" : "" };
      mocks.applyProviderConfigDefaultsForConfig.mockImplementation(
        ({ config, env: providerEnv }: { config: OpenClawConfig; env: NodeJS.ProcessEnv }) => ({
          ...config,
          agents: {
            ...config.agents,
            defaults: {
              ...config.agents?.defaults,
              ...(providerEnv.ANTHROPIC_API_KEY
                ? { contextPruning: { mode: "cache-ttl", ttl: "1h" } }
                : {}),
            },
          },
        }),
      );
      const config = materialize({ agents: { defaults: {} } }, env);
      if (source === "staged") {
        expect(config.agents?.defaults?.contextPruning).toEqual({ mode: "cache-ttl", ttl: "1h" });
        expect(mocks.applyProviderConfigDefaultsForConfig).toHaveBeenCalledWith(
          expect.objectContaining({ env }),
        );
      } else {
        expect(config.agents?.defaults?.contextPruning).toBeUndefined();
        expect(mocks.applyProviderConfigDefaultsForConfig).not.toHaveBeenCalled();
      }
      expect(process.env.ANTHROPIC_API_KEY).toBe(source === "ambient" ? "ambient-fixture" : "");
    },
  );

  it("defaults ackReactionScope without deriving other message fields", () => {
    const next = applyMessageDefaults({
      agents: {
        entries: { main: { identity: { name: "Samantha", theme: "helpful sloth", emoji: "🦥" } } },
      },
      messages: {},
    } as never);

    expect(next.messages?.ackReactionScope).toBe("group-mentions");
    expect(next.messages).not.toHaveProperty("responsePrefix");
    expect(next.messages?.groupChat?.mentionPatterns).toBeUndefined();
  });

  it("fills missing agent concurrency defaults", () => {
    const next = applyAgentDefaults({ messages: {} } as never);

    expect(next.agents?.defaults).toMatchObject({
      maxConcurrent: resolveAgentMaxConcurrent(),
      subagents: {
        maxConcurrent: DEFAULT_SUBAGENT_MAX_CONCURRENT,
        archiveAfterMinutes: DEFAULT_SUBAGENT_ARCHIVE_AFTER_MINUTES,
      },
    });
  });

  it("preserves explicit subagent archive default", () => {
    const next = applyAgentDefaults({
      agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
    } as never);

    expect(next.agents?.defaults?.subagents?.archiveAfterMinutes).toBe(0);
    expect(next.agents?.defaults?.subagents?.maxConcurrent).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
  });

  it.each([false, true])(
    "normalizes keyed agent models without authoring a legacy list (projection: %s)",
    (withProjection) => {
      const entries = (ref: string) => ({
        worker: {
          model: { primary: ref, fallbacks: [ref] },
          models: { [ref]: { alias: "worker-model" } },
        },
        helper: { model: ref },
      });
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: entries("google/gemini-3-pro-preview"),
        },
      };
      if (withProjection) {
        attachAgentListProjection(config);
      }

      const next = applyModelDefaults(config, { manifestRegistry: { plugins: [] } });

      expect(next.agents?.entries).toEqual(entries("google/gemini-3.1-pro-preview"));
      expect(Object.keys(next.agents ?? {})).not.toContain("list");
      expect(structuredClone(next)).not.toHaveProperty("agents.list");
    },
  );
});

describe("applyModelDefaults catalog seeding", () => {
  const catalogRegistry = catalog({
    " OpenAI ": {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      models: [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 400_000,
          contextTokens: 272_000,
          maxTokens: 128_000,
          cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
          thinkingLevelMap: { off: "none" },
          compat: { supportsStore: false },
        },
      ],
    },
    openai: {
      models: [{ id: "gpt-5.6-sol", reasoning: false, input: ["text"] }],
    },
  }) as never;

  // Regression: an override entry pinning only sizing fields materialized as a
  // text-only, non-reasoning, zero-cost model, silently dropping vision-gated
  // tools (like `computer`) for that model downstream.
  it.each([
    { providerId: "openai", generatedRows: false },
    { providerId: " OpenAI ", generatedRows: true },
  ])(
    "seeds $providerId models (normalizer supplies rows: $generatedRows)",
    async ({ providerId, generatedRows }) => {
      const { normalizeProviderConfigForConfigDefaults } = await import("./provider-policy.js");
      // SAFETY: config schema accepts omitted model metadata before materialization.
      const models = [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6",
          contextWindow: 1_050_000,
          contextTokens: 922_000,
        },
      ] as ModelProviderConfig["models"];
      vi.mocked(normalizeProviderConfigForConfigDefaults).mockImplementationOnce((params) =>
        generatedRows ? { ...params.providerConfig, models } : params.providerConfig,
      );
      const model = materializedModel(
        withModels(generatedRows ? [] : models, providerId),
        catalogRegistry,
        providerId,
      );
      expect(model).toMatchObject({
        reasoning: true,
        maxTokens: 128_000,
        contextWindow: 1_050_000,
        contextTokens: 922_000,
        name: "GPT-5.6",
      });
      expect(model.input).toEqual(["text", "image"]);
      expect(model.cost).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 });
      expect(model.thinkingLevelMap).toEqual({ off: "none" });
    },
  );

  it("keeps authored metadata authoritative over the catalog row", () => {
    const model = materializedModel(
      withModels([
        modelDefinition("gpt-5.6-sol", {
          name: "text-only override",
          reasoning: false,
          contextWindow: 8_192,
          maxTokens: 4_096,
        }),
      ]),
      catalogRegistry,
    );
    expect(model.input).toEqual(["text"]);
    expect(model.reasoning).toBe(false);
    expect(model.maxTokens).toBe(4_096);
  });

  it("keeps catalog-seeded compatibility out of authored route overrides", () => {
    const sourceConfig = withModels([modelDefinition("gpt-5.6-sol", { name: "GPT-5.6 Sol" })]);
    const runtimeConfig = applyModelDefaults(sourceConfig, { manifestRegistry: catalogRegistry });
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
      kind: "indeterminate" as const,
    }));

    resolveProviderModelRoutes({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      config: runtimeConfig,
      env: {},
      surface: { resolveModelRoutes },
    });

    expect(resolveModelRoutes.mock.calls[0]?.[0]).toMatchObject({
      requestTransportOverrides: "none",
    });
  });

  const catalogFlatCost = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 };
  const authoredFlatCost = { input: 4, output: 24, cacheRead: 0.4, cacheWrite: 5 };
  const authoredTieredCost = {
    ...authoredFlatCost,
    tieredPricing: [{ ...authoredFlatCost, range: [0] as [number] }],
  };
  const catalogTieredCost = {
    ...catalogFlatCost,
    tieredPricing: [
      { ...catalogFlatCost, range: [0, 101] as [number, number] },
      { input: 10, output: 45, cacheRead: 1, cacheWrite: 12.5, range: [101] as [number] },
    ],
  };

  const freeCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const emptyTiers = { ...authoredFlatCost, tieredPricing: [] };
  it.each([
    ["omitted cost inherits catalog tiers", undefined, catalogTieredCost, 0.006675],
    ["empty cost inherits catalog tiers", {}, catalogTieredCost, 0.006675],
    [
      "partial flat cost inherits missing rates but not tiers",
      { input: 4 },
      { ...catalogFlatCost, input: 4 },
      0.0038875,
    ],
    ["authored flat cost excludes catalog tiers", authoredFlatCost, authoredFlatCost, 0.00327],
    [
      "authored zero cost remains free",
      freeCost,
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      0,
    ],
    ["authored tiers replace catalog tiers", authoredTieredCost, authoredTieredCost, 0.00327],
    [
      "authored empty tiers retain flat pricing",
      emptyTiers,
      { ...authoredFlatCost, tieredPricing: [] },
      0.00327,
    ],
  ] as const)("%s", (_name, authoredCost, expectedCost, expectedUsd) => {
    const tieredRegistry = catalog(
      { "pricing-fixture": { models: [{ id: "fixture", cost: catalogTieredCost }] } },
      "pricing-fixture",
    ) as never;
    const model = materializedModel(
      // SAFETY: config schema accepts omitted or partial cost before materialization.
      withModels(
        [{ id: "fixture", name: "Fixture", cost: authoredCost } as never],
        "pricing-fixture",
        "https://pricing.example/v1",
      ),
      tieredRegistry,
      "pricing-fixture",
    );

    expect(model.cost).toEqual(expectedCost);
    expect(
      estimateUsageCost({
        usage: { input: 200, output: 100, cacheRead: 50, cacheWrite: 10 },
        cost: normalizeModelCostConfig(model.cost),
      }),
    ).toBeCloseTo(expectedUsd, 10);
  });

  it("copies frozen catalog metadata before downstream normalization", () => {
    const supportedReasoningEfforts = Object.freeze(["low", "high"]);
    const compat = Object.freeze({ supportedReasoningEfforts });
    const frozenRegistry = catalog({
      openai: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        models: [
          Object.freeze({
            id: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            reasoning: true,
            compat,
          }),
        ],
      },
    }) as never;
    const model = materializedModel(
      withModels([{ id: "gpt-5.6-sol", name: "GPT-5.6" } as never]),
      frozenRegistry,
    );

    expect(() => {
      model.compat!.supportedReasoningEfforts = ["low"];
    }).not.toThrow();
    expect(compat.supportedReasoningEfforts).toEqual(["low", "high"]);
  });

  it("falls back to generic defaults when no catalog row matches", () => {
    const model = materializedModel(
      // SAFETY: mirrors a real operator config entry that omits input/reasoning/cost.
      withModels(
        [{ id: "house-model", name: "House Model" } as never],
        "custom",
        "https://custom.example.com/v1",
      ),
      catalogRegistry,
      "custom",
    );
    expect(model.input).toEqual(["text"]);
    expect(model.reasoning).toBe(false);
  });
});
