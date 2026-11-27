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
import { resolveProviderPolicySurface } from "../plugins/provider-public-artifacts.js";
import {
  PREPARED_THINKING_POLICY,
  type PreparedThinkingPolicy,
  type ThinkingCatalogPolicyCarrier,
} from "../plugins/provider-thinking-catalog.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { fixedStoreOwnershipConfig } from "./server-methods/sessions-fixed-store.test-support.js";
import { listSessionFixture } from "./session-list.test-support.js";
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
    agents: { defaults: { ...defaults, models: { [model]: { agentRuntime: { id } } } } },
  };
}

const mainThinking = { cfg: {}, agentId: "main", agentRuntime: "openclaw" };
function policyEntry(provider: string, resolve: PreparedThinkingPolicy["resolve"] | null) {
  return catalogEntry(provider, "Reasoner", {
    reasoning: true,
    [PREPARED_THINKING_POLICY]: resolve && { resolve },
  });
}

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
    expect(projection).toMatchObject({ thinkingDefault: "off", effectiveThinkingLevel: "off" });
  }
});

it("clamps the patch projection without overwriting stored Ultra", () => {
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
  const logicalPolicy: PreparedThinkingPolicy["resolve"] = () => ({
    levels: [{ id: "off" }, { id: "medium" }, { id: "high" }],
    defaultLevel: "medium",
  });
  const donorPolicy: PreparedThinkingPolicy["resolve"] = () => ({
    levels: [{ id: "off" }, { id: "low", label: "On" }, { id: "high" }],
    defaultLevel: "high",
  });
  const catalog = [policyEntry("logical", logicalPolicy), policyEntry("donor", donorPolicy)];
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
});

it("retains an authoritative absent policy across all default and clamp reads", () => {
  const otherPolicy = vi.fn<PreparedThinkingPolicy["resolve"]>(() => ({
    levels: [{ id: "high" }],
    defaultLevel: "high",
  }));
  const catalog = [policyEntry("captured-null", null)];
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
  beforeEach(clearAgentHarnesses);
  afterAll(() => restoreRegisteredAgentHarnesses(registeredHarnesses));

  it.each([
    { api: true, levels: ["Off", "High"] },
    { api: false, levels: ["Off"] },
  ])("uses catalog-only runtime route facts (api=$api)", (scenario) => {
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
          baseUrl,
        }),
      ],
    };
    try {
      expect(thinkingProfile(params).thinkingLevels.map(({ label }) => label)).toEqual(
        scenario.levels,
      );
      expect(
        thinkingProjection({ ...params, entry: session("catalog-route") }).thinkingOptions,
      ).toEqual(scenario.levels);
    } finally {
      profile.mockRestore();
    }
  });

  it("projects the prepared ACP runtime for a bare key under its resolved owner", () => {
    const cfg: OpenClawConfig = fixedStoreOwnershipConfig("/tmp/shared.sqlite");

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
    "refreshes configured context for %s",
    async (selected) => {
      await withStateDirEnv("session-context-projection-", async ({ stateDir }) => {
        const models: ModelDefinitionConfig[] = [
          {
            id: "selected",
            name: "Selected",
            input: ["text"],
            reasoning: false,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            maxTokens: 4096,
            contextWindow: 128_000,
            contextTokens: 80_000,
          },
        ];
        const providerConfig = { baseUrl: "https://example.invalid", models };
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          agents: { entries: { main: {} }, defaults: { model: "custom/selected" } },
          models: { providers: { custom: providerConfig } },
        };
        setActivePluginRegistry(createEmptyPluginRegistry());
        setRuntimeConfigSnapshot(cfg);
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
          rowContext: rowContext({ now: 1 }),
          lightweightListRow: true,
          modelCatalog: [catalogEntry("custom", selected, { contextWindow: 128_000 })],
        } satisfies Parameters<typeof sessionRow>[0];
        expect(sessionRow(params)).toMatchObject({
          modelProvider: "custom",
          model: selected,
          contextTokens: selected === "selected" ? 80_000 : 128_000,
        });
        providerConfig.models = models.map((model) =>
          Object.assign({}, model, { contextTokens: 96_000 }),
        );
        entry.modelOverride = "selected";
        expect(sessionRow(params)).toMatchObject({
          model: "selected",
          contextTokens: 96_000,
        });
      });
    },
  );

  test.each([
    ["demo-cli", "shared-model", "demo-provider"],
    ["standalone-cli", "shared-model", "standalone-cli"],
    ["demo-cli", "demo-provider/shared-model", "demo-provider"],
  ])("keeps %s/%s identity across session reads", async (provider, model, expectedProvider) => {
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
      const selected = `${provider}/${model}`;
      const cfg = runtimeConfig(selected, "openclaw", { model: "unrelated/shared-model" });
      cfg.agents = { ...cfg.agents, entries: { main: {} } };
      setRuntimeConfigSnapshot(cfg);
      const key = "agent:main:identity";
      const entry = session("identity", {
        providerOverride: provider,
        modelOverride: model,
        modelOverrideRouteResolution: "resolved",
      });
      const source = { cfg, storePath: stateDir, store: { [key]: entry }, key, entry };
      const expected = { modelProvider: expectedProvider, model: "shared-model" };
      for (const lightweightListRow of [false, true]) {
        expect(sessionRow({ ...source, agentId: "main", lightweightListRow })).toMatchObject({
          ...expected,
          agentRuntime: { id: "openclaw" },
        });
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
        opts: { agentId: "main", search: `${expectedProvider}/shared-model` },
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
