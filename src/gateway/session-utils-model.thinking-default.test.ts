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
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveProviderPolicySurface } from "../plugins/provider-public-artifacts.js";
import {
  PREPARED_THINKING_POLICY,
  type PreparedThinkingPolicy,
  type ThinkingCatalogPolicyCarrier,
} from "../plugins/provider-thinking-catalog.js";
import type { ProviderThinkingRegistry } from "../plugins/provider-thinking.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { resolveSessionSelectedModelRef } from "./session-utils-model-selection.js";
import {
  resolveGatewayModelThinkingProfile,
  resolveGatewaySessionThinkingProjectionInternal,
  getSessionDefaults,
  projectSessionPatchResult,
} from "./session-utils-model.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";

it("keeps runtime capacity reads separate from cached API capability donors", () => {
  const context = buildSessionListRowMetadataContext({ now: 1 });
  const entry: ModelCatalogEntry = {
    provider: "fixture",
    id: "local-model",
    name: "Local model",
    contextTokens: 32_768,
  };
  const selection = { entry, routeVariants: [entry], runtimeId: "native-fixture" };
  expect(context.selectModelCatalogRuntimeEntry(selection).entry.contextTokens).toBe(32_768);
  expect(
    context.selectModelCatalogRuntimeEntry({ ...selection, allowApiFallback: false }).entry
      .contextTokens,
  ).toBeUndefined();
});

describe("Gateway stored thinking levels", () => {
  it("keeps stored Ultra for supported harnesses and clamps unavailable native profiles", () => {
    // A synthetic model lets observed native efforts define the capability set.
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/native-effort-fixture" },
          models: {
            "openai/native-effort-fixture": { agentRuntime: { id: "codex" } },
          },
        },
      },
    };
    const openaiPolicy = expectDefined(
      resolveProviderPolicySurface("openai")?.resolveThinkingProfile,
      "OpenAI public thinking policy",
    );
    const row = (
      entry: SessionEntry,
      catalog?: { reasoning?: boolean; compat?: { supportedReasoningEfforts: string[] } },
    ) => {
      const modelCatalog: (ModelCatalogEntry & ThinkingCatalogPolicyCarrier)[] | undefined = catalog
        ? [
            {
              provider: "openai",
              id: "native-effort-fixture",
              name: "Native effort fixture",
              [PREPARED_THINKING_POLICY]: { resolve: openaiPolicy },
              ...catalog,
            },
          ]
        : undefined;
      return buildGatewaySessionRow({
        cfg,
        agentId: "main",
        lightweightListRow: true,
        rowContext: buildSessionListRowMetadataContext({ now: 1 }),
        storePath: "",
        store: {},
        key: "agent:main:main",
        entry,
        modelCatalog,
      });
    };

    const stored: SessionEntry = { sessionId: "stored", updatedAt: 1, thinkingLevel: "ultra" };

    expect(row(stored).thinkingLevel).toBe("ultra");
    expect(row(stored, {}).thinkingLevel).toBe("ultra");
    expect(row(stored, { reasoning: true }).thinkingLevel).toBe("ultra");
    expect(row(stored, { reasoning: false }).thinkingLevel).toBe("off");
    expect(
      row(stored, { reasoning: true, compat: { supportedReasoningEfforts: ["off"] } })
        .thinkingLevel,
    ).toBe("off");
    expect(
      row(stored, { reasoning: true, compat: { supportedReasoningEfforts: ["max"] } })
        .thinkingLevel,
    ).toBe("ultra");
    const nativeUltra = row(stored, {
      reasoning: true,
      compat: { supportedReasoningEfforts: ["max", "ultra"] },
    });
    expect(nativeUltra.thinkingLevel).toBe("ultra");
    expect(nativeUltra.thinkingLevels).toContainEqual({ id: "ultra", label: "ultra" });
  });
});

describe("Gateway all-null thinking map", () => {
  it.each([undefined, "ultra"] as const)(
    "preserves the explicit default %s without native levels",
    (thinkingDefault) => {
      const profile = resolveGatewayModelThinkingProfile({
        cfg: { agents: { defaults: { thinkingDefault } } },
        agentId: "main",
        provider: "metadata-fixture",
        model: "no-effort",
        agentRuntime: "openclaw",
        modelCatalog: [
          {
            provider: "metadata-fixture",
            id: "no-effort",
            name: "No selectable effort",
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
          },
        ],
      });

      expect(profile.thinkingLevels).toEqual([{ id: "ultra", label: "ultra" }]);
      expect(profile.thinkingDefault).toBe(thinkingDefault);
    },
  );
});

describe("Gateway captured thinking defaults", () => {
  const provider = "captured-thinking-default-fixture";
  const captured: ProviderThinkingRegistry = {
    providers: [
      {
        provider: {
          id: provider,
          resolveThinkingProfile: () => ({
            // Medium stays supported so clamping cannot hide a lost policy source.
            levels: [{ id: "off" }, { id: "low" }, { id: "medium" }],
            defaultLevel: "low",
          }),
        },
      },
    ],
  };

  it("projects the agent-specific model default above shared model and global defaults", () => {
    const ref = `${provider}/reasoner`;
    const profile = resolveGatewayModelThinkingProfile({
      cfg: {
        agents: {
          defaults: {
            thinkingDefault: "medium",
            models: { [ref]: { params: { thinking: "low" } } },
          },
          entries: { main: { models: { [ref]: { params: { thinking: "off" } } } } },
        },
      },
      agentId: "main",
      provider,
      model: "reasoner",
      agentRuntime: "openclaw",
      providerPolicySource: captured,
      modelCatalog: [{ provider, id: "reasoner", name: "Reasoner", reasoning: true }],
    });

    expect(profile.thinkingDefault).toBe("off");
  });
});

describe("Gateway thinking catalog", () => {
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
      {
        provider: "logical",
        id: "Reasoner",
        name: "Logical",
        reasoning: true,
        [PREPARED_THINKING_POLICY]: { resolve: logicalPolicy },
      },
      {
        provider: "donor",
        id: "Reasoner",
        name: "Donor",
        reasoning: true,
        [PREPARED_THINKING_POLICY]: { resolve: donorPolicy },
      },
    ];
    const profile = resolveGatewayModelThinkingProfile({
      cfg: {},
      agentId: "main",
      provider: "logical",
      model: "Reasoner",
      thinkingPolicyProvider: "donor",
      agentRuntime: "openclaw",
      modelCatalog: catalog,
      catalogResolver: thinking.createThinkingCatalogResolver(catalog),
    });
    expect(profile.thinkingLevels).toEqual([
      { id: "off", label: "off" },
      { id: "low", label: "On" },
      { id: "high", label: "high" },
      { id: "ultra", label: "ultra" },
    ]);
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
      {
        provider: "captured-null",
        id: "Reasoner",
        name: "Reasoner",
        reasoning: true,
        [PREPARED_THINKING_POLICY]: null,
      },
    ];
    const profile = resolveGatewayModelThinkingProfile({
      cfg: {},
      agentId: "main",
      provider: "captured-null",
      model: "Reasoner",
      agentRuntime: "openclaw",
      modelCatalog: catalog,
      catalogResolver: thinking.createThinkingCatalogResolver(catalog),
      providerPolicySource: {
        providers: [{ provider: { id: "captured-null", resolveThinkingProfile: otherPolicy } }],
      },
    });
    expect(profile.thinkingLevels.map(({ id }) => id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "ultra",
    ]);
    expect(profile.thinkingDefault).toBe("medium");
    expect(otherPolicy).not.toHaveBeenCalled();
  });
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
      runAttempt: async () => {
        throw new Error("projection must not execute");
      },
    });
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          thinkingDefault: "off",
          models: { "route-provider/route-model": { agentRuntime: { id: "catalog-route" } } },
        },
      },
    };
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
        {
          provider: "route-provider",
          id: "route-model",
          name: "Route model",
          reasoning: true,
          ...(scenario.api ? { api } : {}),
          ...(scenario.baseUrl ? { baseUrl } : {}),
        },
      ],
    };
    try {
      expect(
        resolveGatewayModelThinkingProfile(params).thinkingLevels.map(({ label }) => label),
      ).toEqual(scenario.levels);
      expect(
        resolveGatewaySessionThinkingProjectionInternal({
          ...params,
          entry: { sessionId: "catalog-route", updatedAt: 1 },
        }).thinkingOptions,
      ).toEqual(scenario.levels);
    } finally {
      profile.mockRestore();
    }
  });

  it.each([false, true])(
    "projects the effective model runtime with authored transport=%s",
    (transportOverride) => {
      registerAgentHarness({
        id: "codex",
        label: "Codex",
        supports: (ctx) =>
          ctx.modelProvider?.requestTransportOverrides === "present"
            ? { supported: false, fallbackRuntime: "openclaw" }
            : { supported: true },
        runAttempt: async () => {
          throw new Error("projection must not execute");
        },
      });
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } } } },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-responses",
              models: [
                {
                  id: "gpt-5.6-sol",
                  name: "Sol",
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 8192,
                  compat: {
                    supportsReasoningEffort: true,
                    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
                    ...(transportOverride ? { supportsStore: false } : {}),
                  },
                },
              ],
            },
          },
        },
      };
      const projection = resolveGatewaySessionThinkingProjectionInternal({
        cfg,
        agentId: "main",
        provider: "openai",
        model: "gpt-5.6-sol",
        sessionKey: "agent:main:main",
        entry: {
          sessionId: "runtime-projection",
          updatedAt: 1,
          agentHarnessId: transportOverride ? "codex" : "openclaw",
        },
      });
      expect(projection.agentRuntime).toEqual({
        id: transportOverride ? "openclaw" : "codex",
        source: "model",
      });
    },
  );

  it("projects the prepared ACP runtime for a bare key under its resolved owner", () => {
    const cfg: OpenClawConfig = {
      session: { scope: "global", store: "/tmp/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    };

    const projection = resolveGatewaySessionThinkingProjectionInternal({
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
    "projects current context limits with one configured catalog traversal for %s",
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
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
        const rowContext = buildSessionListRowMetadataContext({ now: 1 });
        const entry: SessionEntry = {
          sessionId: "context-projection",
          updatedAt: 1,
          providerOverride: "custom",
          modelOverride: selected,
          modelOverrideRouteResolution: "resolved",
        };
        const key = "agent:main:context-projection";
        const params = {
          cfg,
          agentId: "main",
          key,
          entry,
          store: { [key]: entry },
          storePath: stateDir,
          now: 1,
          rowContext,
          lightweightListRow: true,
          modelCatalog: [
            { provider: "custom", id: selected, name: selected, contextWindow: 128_000 },
          ],
        } satisfies Parameters<typeof buildGatewaySessionRow>[0];
        visits = 0;
        for (let index = 0; index < 32; index++) {
          expect(buildGatewaySessionRow(params)).toMatchObject({
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
        expect(buildGatewaySessionRow(params)).toMatchObject({
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
    const entry: SessionEntry = { sessionId: "written-model", updatedAt: 1 };
    applyModelOverrideToSessionEntry({ entry, selection: { provider: "custom", model } });
    return structuredClone(entry);
  }

  async function withIdentityScope(run: () => void): Promise<void> {
    await withStateDirEnv("session-override-identity-", async () =>
      withPluginRuntimeGenerationScope({ metadataSnapshot: identityMetadata }, run),
    );
  }

  test.each([false, true])(
    "projects raw and resolved selections once (resolved first=%s)",
    async (resolvedFirst) => {
      await withIdentityScope(() => {
        const resolved = { entry: writtenModelOverride("middle"), model: "middle" };
        const raw = {
          entry: {
            sessionId: "raw-model",
            updatedAt: 1,
            providerOverride: "custom",
            modelOverride: "latest",
          },
          model: "middle",
        };
        const rowContext = buildSessionListRowMetadataContext({ now: 1 });
        for (const { entry, model } of resolvedFirst ? [resolved, raw] : [raw, resolved]) {
          expect
            .soft(
              resolveSessionSelectedModelRef({
                cfg: identityConfig,
                agentId: "main",
                source: { entry, readSourceEntry: () => undefined },
                rowContext,
                allowPluginNormalization: false,
              }),
            )
            .toEqual({ provider: "custom", model, storedOverrideSource: "session" });
        }
      });
    },
  );

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
        {
          pluginId: "fixture",
          source: "fixture",
          backend: {
            id: "demo-cli",
            modelProvider: "demo-provider",
            config: { command: "false", output: "text", input: "arg" },
          },
        },
        {
          pluginId: "fixture",
          source: "fixture",
          backend: {
            id: "standalone-cli",
            config: { command: "false", output: "text", input: "arg" },
          },
        },
      ];
      setActivePluginRegistry(registry);
      const selected = `${fixture.provider}/${fixture.model}`;
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: {
            model: "unrelated/shared-model",
            models: { [selected]: { agentRuntime: { id: "openclaw" } } },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const key = "agent:main:identity";
      const entry: SessionEntry = {
        sessionId: "identity",
        updatedAt: 1,
        providerOverride: fixture.provider,
        modelOverride: fixture.model,
        modelOverrideRouteResolution: "resolved",
      };
      const store = { [key]: entry };
      const expected = { modelProvider: fixture.expectedProvider, model: "shared-model" };
      for (const lightweightListRow of [false, true]) {
        const row = buildGatewaySessionRow({
          cfg,
          agentId: "main",
          storePath: stateDir,
          store,
          key,
          entry,
          lightweightListRow,
        });
        expect(row).toMatchObject(expected);
        expect(row.agentRuntime?.id).toBe("openclaw");
      }
      expect(
        projectSessionPatchResult({
          cfg,
          canonicalKey: key,
          entry,
          preparedAcpMeta: null,
          targetAgentId: "main",
          storePath: stateDir,
        }).resolved,
      ).toMatchObject({ ...expected, agentRuntime: { id: "openclaw" } });
      const listed = await listSessionFixture({
        cfg,
        storePath: stateDir,
        store,
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
