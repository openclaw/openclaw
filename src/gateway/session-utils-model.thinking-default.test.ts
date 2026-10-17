import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import {
  clearAgentHarnesses,
  listRegisteredAgentHarnesses,
  registerAgentHarness,
} from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import * as thinking from "../auto-reply/thinking.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveProviderPolicySurface } from "../plugins/provider-public-artifacts.js";
import {
  PREPARED_THINKING_POLICY,
  type PreparedThinkingPolicy,
  type ThinkingCatalogPolicyCarrier,
} from "../plugins/provider-thinking-catalog.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { resolveSessionSelectedModelRef } from "./session-utils-model-selection.js";
import {
  resolveGatewayModelThinkingProfile as thinkingProfile,
  resolveGatewaySessionThinkingProjectionInternal as thinkingProjection,
  getSessionDefaults,
  projectSessionPatchResult as patchResult,
} from "./session-utils-model.js";
import { buildSessionListRowMetadataContext as rowContext } from "./session-utils-projection.js";
import { buildGatewaySessionRow as sessionRow } from "./session-utils-row.js";

function catalogEntry(
  provider: string,
  id: string,
  fields: Partial<ModelCatalogEntry & ThinkingCatalogPolicyCarrier> = {},
): ModelCatalogEntry & ThinkingCatalogPolicyCarrier {
  return { provider, id, name: id, ...fields };
}

function session(sessionId: string, fields: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId, updatedAt: 1, ...fields };
}

function runtimeConfig(
  model: string,
  id: string,
  defaults: AgentDefaultsConfig = {},
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        ...defaults,
        models: { [model]: { agentRuntime: { id } } },
      },
    },
  };
}

const mainThinking = { cfg: {}, agentId: "main", agentRuntime: "openclaw" };
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const projectionMustNotRun = async () => {
  throw new Error("projection must not execute");
};

it("keeps runtime capacity reads separate from cached API capability donors", () => {
  const context = rowContext({ now: 1 });
  const entry = catalogEntry("fixture", "local-model", { contextTokens: 32_768 });
  const selection = { entry, routeVariants: [entry], runtimeId: "native-fixture" };
  expect(context.selectModelCatalogRuntimeEntry(selection).entry.contextTokens).toBe(32_768);
  expect(
    context.selectModelCatalogRuntimeEntry({ ...selection, allowApiFallback: false }).entry
      .contextTokens,
  ).toBeUndefined();
});

it.each([false, true])("keeps configured reasoning=%s on runtime routes", (reasoning) => {
  const logicalEntry = catalogEntry("openai", "gpt-5.4", {
    api: "openai-chatgpt-responses",
    reasoning,
  });
  const projection = thinkingProjection({
    cfg: runtimeConfig("openai/gpt-5.4", "openclaw"),
    agentId: "main",
    sessionKey: "agent:main:route",
    provider: "openai",
    model: "gpt-5.4",
    entry: session("route", { thinkingLevel: "high" }),
    modelCatalog: [logicalEntry],
    modelCatalogRouteVariants: [
      { ...logicalEntry, api: "openai-responses", reasoning: true, nativeRuntime: "openclaw" },
    ],
  });
  const levels = projection.thinkingLevels.map(({ id }) => id);
  if (reasoning) {
    expect(levels).toContain("high");
    expect(projection.effectiveThinkingLevel).toBe("high");
  } else {
    expect(levels).toEqual(["off", "ultra"]);
    expect(projection.thinkingDefault).toBe("off");
    expect(projection.effectiveThinkingLevel).toBe("off");
  }
});

it("keeps stored Ultra for supported harnesses and clamps unavailable native profiles", () => {
  // A synthetic model lets observed native efforts define the capability set.
  const cfg = runtimeConfig("openai/native-effort-fixture", "codex", {
    model: { primary: "openai/native-effort-fixture" },
  });
  const openaiPolicy = expectDefined(
    resolveProviderPolicySurface("openai")?.resolveThinkingProfile,
    "OpenAI public thinking policy",
  );
  const modelEntry = catalogEntry("openai", "native-effort-fixture", {
    [PREPARED_THINKING_POLICY]: { resolve: openaiPolicy },
  });
  const stored = session("stored", { thinkingLevel: "ultra" });
  const row = (catalog?: Pick<ModelCatalogEntry, "reasoning" | "compat">) =>
    sessionRow({
      cfg,
      agentId: "main",
      lightweightListRow: true,
      rowContext: rowContext({ now: 1 }),
      storePath: "",
      store: {},
      key: "agent:main:main",
      entry: stored,
      modelCatalog: catalog ? [{ ...modelEntry, ...catalog }] : undefined,
    });

  for (const catalog of [
    undefined,
    {},
    { reasoning: true },
    { reasoning: false },
    { reasoning: true, compat: { supportedReasoningEfforts: ["off"] } },
    { reasoning: true, compat: { supportedReasoningEfforts: ["max"] } },
  ]) {
    expect(row(catalog).thinkingLevel).toBe("ultra");
  }
  const nativeUltra = row({
    reasoning: true,
    compat: { supportedReasoningEfforts: ["max", "ultra"] },
  });
  expect(nativeUltra.thinkingLevel).toBe("ultra");
  expect(nativeUltra.thinkingLevels).toContainEqual({ id: "ultra", label: "ultra" });
  expect(
    patchResult({
      cfg,
      targetAgentId: "main",
      canonicalKey: "agent:main:main",
      entry: stored,
      storePath: "/tmp/agents/main/sessions/sessions.json",
      preparedAcpMeta: null,
      modelCatalog: [{ ...modelEntry, reasoning: false }],
    }),
  ).toMatchObject({
    entry: { thinkingLevel: "ultra" },
    resolved: { thinkingLevel: "off" },
  });
});

it.each([undefined, "ultra"] as const)(
  "keeps explicit default %s without native levels",
  (thinkingDefault) => {
    const profile = thinkingProfile({
      ...mainThinking,
      cfg: { agents: { defaults: { thinkingDefault } } },
      provider: "metadata-fixture",
      model: "no-effort",
      modelCatalog: [
        catalogEntry("metadata-fixture", "no-effort", {
          api: "openai-completions",
          reasoning: true,
          thinkingLevelMap: {
            off: null,
            minimal: null,
            low: null,
            medium: null,
            high: null,
            xhigh: null,
            max: null,
          },
        }),
      ],
    });

    expect(profile.thinkingLevels).toEqual([{ id: "ultra", label: "ultra" }]);
    expect(profile.thinkingDefault).toBe(thinkingDefault);
  },
);

it("keeps logical defaults separate from donor levels", () => {
  const logicalPolicy = vi.fn<PreparedThinkingPolicy["resolve"]>(() => ({
    levels: [{ id: "off" }, { id: "medium" }, { id: "high" }],
    defaultLevel: "medium",
  }));
  const donorPolicy = vi.fn<PreparedThinkingPolicy["resolve"]>(() => ({
    levels: [{ id: "off" }, { id: "low", label: "On" }, { id: "high" }],
    defaultLevel: "high",
  }));
  const catalog: (ModelCatalogEntry & ThinkingCatalogPolicyCarrier)[] = [
    catalogEntry("logical", "Reasoner", {
      reasoning: true,
      [PREPARED_THINKING_POLICY]: { resolve: logicalPolicy },
    }),
    catalogEntry("donor", "Reasoner", {
      reasoning: true,
      [PREPARED_THINKING_POLICY]: { resolve: donorPolicy },
    }),
  ];
  const profile = thinkingProfile({
    ...mainThinking,
    provider: "logical",
    model: "Reasoner",
    thinkingPolicyProvider: "donor",
    modelCatalog: catalog,
    catalogResolver: thinking.createThinkingCatalogResolver(catalog),
  });
  expect(profile.thinkingLevels).toEqual(
    ["off", "low", "high", "ultra"].map((id) => ({ id, label: id === "low" ? "On" : id })),
  );
  expect(profile.thinkingDefault).toBe("low");
  expect(logicalPolicy).toHaveBeenCalledTimes(1);
  expect(donorPolicy).toHaveBeenCalledTimes(1);
});

it("retains an authoritative absent policy across all default and clamp reads", () => {
  const otherPolicy = vi.fn<PreparedThinkingPolicy["resolve"]>(() => ({
    levels: [{ id: "high" }],
    defaultLevel: "high",
  }));
  const catalog: (ModelCatalogEntry & ThinkingCatalogPolicyCarrier)[] = [
    catalogEntry("captured-null", "Reasoner", {
      reasoning: true,
      [PREPARED_THINKING_POLICY]: null,
    }),
  ];
  const profile = thinkingProfile({
    ...mainThinking,
    provider: "captured-null",
    model: "Reasoner",
    modelCatalog: catalog,
    catalogResolver: thinking.createThinkingCatalogResolver(catalog),
    providerPolicySource: {
      providers: [{ provider: { id: "captured-null", resolveThinkingProfile: otherPolicy } }],
    },
  });
  const levels = profile.thinkingLevels.map(({ id }) => id);
  expect(levels).toEqual(["off", "minimal", "low", "medium", "high", "ultra"]);
  expect(profile.thinkingDefault).toBe("medium");
  expect(otherPolicy).not.toHaveBeenCalled();
});

describe("resolveGatewaySessionThinkingProjectionInternal", () => {
  const registeredHarnesses = listRegisteredAgentHarnesses();
  beforeEach(() => {
    clearAgentHarnesses();
  });
  afterAll(() => restoreRegisteredAgentHarnesses(registeredHarnesses));

  it.each([
    { api: true, baseUrl: true, levels: ["Off", "High"] },
    { api: false, baseUrl: true, levels: ["Off"] },
  ])("uses catalog-only runtime route facts (api=$api, baseUrl=$baseUrl)", (scenario) => {
    const api = "openai-responses" as const;
    const baseUrl = "https://catalog-route.example.test/v1";
    registerAgentHarness({
      id: "catalog-route",
      label: "Catalog route",
      supports: ({ modelProvider }) =>
        modelProvider?.api === api && modelProvider.baseUrl === baseUrl
          ? { supported: true }
          : { supported: false, fallbackRuntime: "openclaw" },
      runAttempt: projectionMustNotRun,
    });
    const cfg = runtimeConfig("route-provider/route-model", "catalog-route", {
      thinkingDefault: "off",
    });
    const profile = vi.spyOn(thinking, "resolveThinkingProfile").mockImplementation((params) => ({
      levels: [
        { id: "off", label: "Off", rank: 0 },
        ...(params.agentRuntime === "catalog-route"
          ? [{ id: "high" as const, label: "High", rank: 3 }]
          : []),
      ],
      defaultLevel: "off",
    }));
    const params = {
      cfg,
      agentId: "main",
      provider: "route-provider",
      model: "route-model",
      sessionKey: "agent:main:catalog-route",
      modelCatalog: [
        catalogEntry("route-provider", "route-model", {
          reasoning: true,
          ...(scenario.api ? { api } : {}),
          ...(scenario.baseUrl ? { baseUrl } : {}),
        }),
      ],
    };
    try {
      expect(thinkingProfile(params).thinkingLevels.map(({ label }) => label)).toEqual(
        scenario.levels,
      );
      expect(
        thinkingProjection({
          ...params,
          entry: session("catalog-route"),
        }).thinkingOptions,
      ).toEqual(scenario.levels);
    } finally {
      profile.mockRestore();
    }
  });

  it.each([false, true])("projects effective runtime with transport=%s", (transportOverride) => {
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: (ctx) =>
        ctx.modelProvider?.requestTransportOverrides === "present"
          ? { supported: false, fallbackRuntime: "openclaw" }
          : { supported: true },
      runAttempt: projectionMustNotRun,
    });
    const definition: ModelDefinitionConfig = {
      id: "gpt-5.6-sol",
      name: "Sol",
      reasoning: true,
      input: ["text"],
      cost: zeroCost,
      maxTokens: 8192,
      compat: {
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        ...(transportOverride ? { supportsStore: false } : {}),
      },
    };
    const provider = {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses" as const,
      models: [definition],
    };
    const cfg: OpenClawConfig = {
      ...runtimeConfig("openai/gpt-5.6-sol", "codex"),
      models: { providers: { openai: provider } },
    };
    const projection = thinkingProjection({
      cfg,
      agentId: "main",
      provider: "openai",
      model: "gpt-5.6-sol",
      sessionKey: "agent:main:main",
      entry: session("runtime-projection", {
        agentHarnessId: transportOverride ? "codex" : "openclaw",
      }),
    });
    expect(projection.agentRuntime).toEqual({
      id: transportOverride ? "openclaw" : "codex",
      source: "model",
    });
  });

  it("projects the prepared ACP runtime for a bare key under its resolved owner", () => {
    const cfg: OpenClawConfig = {
      session: { scope: "global", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    const projection = thinkingProjection({
      cfg,
      agentId: "ops",
      provider: "openai",
      model: "gpt-5.6-sol",
      sessionKey: "global",
      preparedAcpMeta: {
        backend: "acpx",
        agent: "ops",
        runtimeSessionName: "global",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 1,
      },
    });

    expect(projection.agentRuntime).toEqual({ id: "acpx", source: "session-key" });
  });
});

describe("Gateway model identity", () => {
  afterEach(() => {
    resetConfigRuntimeState();
    resetPluginRuntimeStateForTest();
  });

  test.each(["selected", "custom/missing"])(
    "refreshes context without rescanning for %s",
    async (selected) => {
      await withStateDirEnv("session-context-projection-", async ({ stateDir }) => {
        const rows: ModelDefinitionConfig[] = Array.from({ length: 64 }, (_, index) => ({
          id: index === 63 ? "selected" : `model-${index}`,
          name: `Model ${index}`,
          contextWindow: 128_000,
          contextTokens: 80_000,
          maxTokens: 4096,
          input: ["text"],
          reasoning: false,
          cost: zeroCost,
        }));
        let visits = 0;
        const models = [...rows];
        Object.defineProperty(models, Symbol.iterator, {
          *value() {
            for (const row of rows) {
              visits++;
              yield row;
            }
          },
        });
        const providerConfig = { baseUrl: "https://example.invalid", models };
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          agents: { entries: { main: {} }, defaults: { model: "custom/selected" } },
          models: { providers: { custom: providerConfig } },
        };
        setActivePluginRegistry(createEmptyPluginRegistry());
        setRuntimeConfigSnapshot(cfg);
        const context = rowContext({ now: 1 });
        const entry = session("context-projection", {
          providerOverride: "custom",
          modelOverride: selected,
          modelOverrideRouteResolution: "resolved",
        });
        const key = "agent:main:context-projection";
        const params = {
          cfg,
          agentId: "main",
          key,
          entry,
          store: { [key]: entry },
          storePath: stateDir,
          now: 1,
          rowContext: context,
          lightweightListRow: true,
          modelCatalog: [catalogEntry("custom", selected, { contextWindow: 128_000 })],
        } satisfies Parameters<typeof sessionRow>[0];
        visits = 0;
        for (let index = 0; index < 32; index++) {
          expect(sessionRow(params)).toMatchObject({
            modelProvider: "custom",
            model: selected,
            contextTokens: selected === "selected" ? 80_000 : 128_000,
          });
        }
        expect(visits).toBeLessThanOrEqual(rows.length * 32);
        providerConfig.models = structuredClone(rows);
        for (const model of providerConfig.models) {
          model.contextTokens = 96_000;
        }
        entry.modelOverride = "selected";
        expect(sessionRow(params)).toMatchObject({
          model: "selected",
          contextTokens: 96_000,
        });
      });
    },
  );

  const identityConfig: OpenClawConfig = {
    plugins: { enabled: false },
    agents: { entries: { main: {} }, defaults: { model: "custom/default" } },
  };
  const identityMetadata = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "custom",
        providers: ["custom"],
        modelIdNormalization: {
          providers: { custom: { aliases: { latest: "middle", middle: "final" } } },
        },
      },
    ],
  });

  function writtenModelOverride(model: string): SessionEntry {
    const entry = session("written-model");
    applyModelOverrideToSessionEntry({ entry, selection: { provider: "custom", model } });
    return structuredClone(entry);
  }

  async function withIdentityScope(run: () => void): Promise<void> {
    await withStateDirEnv("session-override-identity-", async () =>
      withPluginRuntimeGenerationScope({ metadataSnapshot: identityMetadata }, run),
    );
  }

  test.each([false, true])("normalizes once with resolved-first=%s", async (resolvedFirst) => {
    await withIdentityScope(() => {
      const resolved = { entry: writtenModelOverride("middle"), model: "middle" };
      const raw = {
        entry: session("raw-model", {
          providerOverride: "custom",
          modelOverride: "latest",
        }),
        model: "middle",
      };
      const context = rowContext({ now: 1 });
      for (const { entry, model } of resolvedFirst ? [resolved, raw] : [raw, resolved]) {
        const selected = resolveSessionSelectedModelRef({
          cfg: identityConfig,
          agentId: "main",
          source: { entry, readSourceEntry: () => undefined },
          rowContext: context,
          allowPluginNormalization: false,
        });
        expect
          .soft(selected)
          .toEqual({ provider: "custom", model, storedOverrideSource: "session" });
      }
    });
  });

  test.each([
    { provider: "demo-cli", model: "shared-model", expectedProvider: "demo-provider" },
    { provider: "standalone-cli", model: "shared-model", expectedProvider: "standalone-cli" },
    {
      provider: "demo-cli",
      model: "demo-provider/shared-model",
      expectedProvider: "demo-provider",
    },
  ])("keeps $provider/$model identity across session reads", async (fixture) => {
    await withStateDirEnv("session-model-identity-", async ({ stateDir }) => {
      const registry = createEmptyPluginRegistry();
      registry.cliBackends = [
        { id: "demo-cli", modelProvider: "demo-provider" },
        { id: "standalone-cli" },
      ].map((backend): (typeof registry.cliBackends)[number] => ({
        pluginId: "fixture",
        source: "fixture",
        backend: {
          ...backend,
          config: { command: "false", output: "text", input: "arg" },
        },
      }));
      setActivePluginRegistry(registry);
      const selected = `${fixture.provider}/${fixture.model}`;
      const cfg = runtimeConfig(selected, "openclaw", { model: "unrelated/shared-model" });
      cfg.agents = { ...cfg.agents, entries: { main: {} } };
      setRuntimeConfigSnapshot(cfg);
      const key = "agent:main:identity";
      const entry = session("identity", {
        providerOverride: fixture.provider,
        modelOverride: fixture.model,
        modelOverrideRouteResolution: "resolved",
      });
      const store = { [key]: entry };
      const source = { cfg, storePath: stateDir, store, key, entry };
      const expected = { modelProvider: fixture.expectedProvider, model: "shared-model" };
      for (const lightweightListRow of [false, true]) {
        const row = sessionRow({
          ...source,
          agentId: "main",
          lightweightListRow,
        });
        expect(row).toMatchObject(expected);
        expect(row.agentRuntime?.id).toBe("openclaw");
      }
      expect(
        patchResult({
          ...source,
          canonicalKey: key,
          preparedAcpMeta: null,
          targetAgentId: "main",
        }).resolved,
      ).toMatchObject({ ...expected, agentRuntime: { id: "openclaw" } });
      const listed = await listSessionFixture({
        ...source,
        opts: { agentId: "main", search: `${fixture.expectedProvider}/shared-model` },
      });
      expect(listed.sessions).toMatchObject([{ key, ...expected }]);
      const defaultConfig: OpenClawConfig = {
        ...cfg,
        agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, model: selected } },
      };
      expect(getSessionDefaults(defaultConfig, [], { agentId: "main" })).toMatchObject(expected);
    });
  });
});
