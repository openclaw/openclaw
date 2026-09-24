import path from "node:path";
import { expect, test, vi } from "vitest";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { prepareModelCatalogThinkingPolicies } from "../plugins/provider-thinking.js";
import type {
  ProviderThinkingProfile,
  ProviderThinkingRegistry,
} from "../plugins/provider-thinking.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPreparedGatewayModelCatalog } from "./server-model-catalog-view.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { resolveGatewayModelThinkingProfile } from "./session-utils-model.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import { readSessionRowInputs } from "./session-utils-row.js";

function createRowThinkingFixture() {
  const provider = "row-thinking-fixture";
  const cfg: OpenClawConfig = {
    agents: {
      entries: { main: {} },
      defaults: { model: `${provider}/reasoner`, thinkingDefault: "off", utilityModel: "" },
    },
  };
  let policyCalls = 0;
  const policy = (): ProviderThinkingProfile => {
    policyCalls++;
    return {
      levels: [
        { id: "off", label: "Off", rank: 0 },
        { id: "high", label: "Deep", rank: 10 },
        { id: "low", label: "Light", rank: 40 },
      ],
      defaultLevel: "low",
    };
  };
  const pluginRegistry: ProviderThinkingRegistry = {
    providers: [{ provider: { id: provider, resolveThinkingProfile: policy } }],
  };
  const catalog: ModelCatalogSnapshot = {
    entries: [{ provider, id: "reasoner", name: "Reasoner", reasoning: true }],
    routeVariants: [],
  };
  prepareModelCatalogThinkingPolicies({
    catalog,
    providers: pluginRegistry.providers,
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
  });
  const modelCatalog = new Map([
    ["main", createPreparedGatewayModelCatalog({ ...catalog, pluginRegistry })],
  ]);
  const rowContext = buildSessionListRowMetadataContext({ now: 1 });
  const read = (
    thinkingLevel: SessionEntry["thinkingLevel"],
    models: Parameters<typeof readSessionRowInputs>[0]["modelCatalog"],
    index = 0,
  ) =>
    readSessionRowInputs({
      cfg,
      key: `agent:main:thinking-${index}`,
      agentId: "main",
      store: {},
      storePath: "unused",
      entry: {
        sessionId: `thinking-${index}`,
        updatedAt: 1,
        modelProvider: provider,
        model: "reasoner",
        thinkingLevel,
        acp: {
          backend: "openclaw",
          agent: "fixture",
          runtimeSessionName: `thinking-${index}`,
          mode: "oneshot",
          state: "idle",
          lastActivityAt: 1,
        },
      },
      modelCatalog: models,
      rowContext,
      activeModel: null,
      skipTranscriptUsageFallback: true,
    }).inputs.thinkingProjection;
  return {
    cfg,
    provider,
    policyCalls: () => policyCalls,
    pluginRegistry,
    catalog,
    modelCatalog,
    rowContext,
    read,
  };
}

test("reuses prepared thinking policy for stored levels without exposing profile ranks", async () => {
  await withStateDirEnv("openclaw-row-thinking-", async () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const fixture = createRowThinkingFixture();
    expect(fixture.read(undefined, fixture.modelCatalog)).toMatchObject({
      thinkingDefault: "off",
      thinkingOptions: ["Off", "Deep", "Light", "ultra"],
      effectiveThinkingLevel: "off",
    });
    const warmCalls = fixture.policyCalls();
    expect(warmCalls).toBeGreaterThan(0);
    const cases = [
      ["high", "high"],
      ["medium", "high"],
      ["adaptive", "low"],
    ] as const;
    for (const [index, [level, expected]] of cases.entries()) {
      expect(fixture.read(level, fixture.modelCatalog, index + 1)).toMatchObject({
        thinkingLevel: expected,
        effectiveThinkingLevel: expected,
        thinkingDefault: "off",
        thinkingOptions: ["Off", "Deep", "Light", "ultra"],
      });
    }
    const metadata = resolveGatewayModelThinkingProfile({
      cfg: fixture.cfg,
      agentId: "main",
      provider: fixture.provider,
      model: "reasoner",
      agentRuntime: "openclaw",
      modelCatalog: fixture.catalog.entries,
      providerPolicySource: fixture.pluginRegistry,
      rowContext: fixture.rowContext,
    });
    expect(metadata).toEqual({
      thinkingLevels: [
        { id: "off", label: "Off" },
        { id: "high", label: "Deep" },
        { id: "low", label: "Light" },
        { id: "ultra", label: "ultra" },
      ],
      thinkingDefault: "off",
    });
    expect(fixture.policyCalls()).toBe(warmCalls);
  });
});

test.each(["missing", "identity-only"] as const)(
  "preserves a stored level with a %s catalog after warming thinking facts",
  async (kind) => {
    await withStateDirEnv("openclaw-row-thinking-incomplete-", async () => {
      resetPluginRuntimeStateForTest();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const fixture = createRowThinkingFixture();
      fixture.read(undefined, kind === "missing" ? fixture.catalog.entries : fixture.modelCatalog);
      const warmCalls = fixture.policyCalls();
      const catalog =
        kind === "missing"
          ? undefined
          : new Map([
              [
                "main",
                createPreparedGatewayModelCatalog({
                  entries: [{ provider: fixture.provider, id: "reasoner", name: "Reasoner" }],
                  pluginRegistry: fixture.pluginRegistry,
                }),
              ],
            ]);
      expect(fixture.read("medium", catalog, 1)).toMatchObject({
        thinkingLevel: "medium",
        effectiveThinkingLevel: "medium",
        thinkingDefault: "off",
        thinkingOptions: ["Off", "Deep", "Light", "ultra"],
      });
      expect(fixture.policyCalls()).toBe(warmCalls);
    });
  },
);

test("keeps stored thinking levels and defaults scoped to the prepared agent, model and runtime", async () => {
  await withStateDirEnv("openclaw-row-thinking-scope-", async () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const provider = "scoped-thinking-fixture";
    const cfg: OpenClawConfig = {
      agents: {
        entries: { main: {}, work: {} },
        defaults: { model: `${provider}/reasoner`, utilityModel: "" },
      },
    };
    const prepare = (preferLow: boolean) => {
      const pluginRegistry: ProviderThinkingRegistry = {
        providers: [
          {
            provider: {
              id: provider,
              resolveThinkingProfile: ({ modelId, agentRuntime }) => {
                const low = preferLow || modelId === "alternate" || agentRuntime === "codex";
                return {
                  levels: [
                    { id: "off", label: "Off", rank: 0 },
                    { id: "high", label: "High", rank: low ? 40 : 10 },
                    { id: "low", label: "Low", rank: low ? 10 : 40 },
                  ],
                  defaultLevel: low ? "low" : "high",
                };
              },
            },
          },
        ],
      };
      const catalog: ModelCatalogSnapshot = {
        entries: ["reasoner", "alternate"].map((id) => ({
          provider,
          id,
          name: id,
          reasoning: true,
        })),
        routeVariants: [],
      };
      prepareModelCatalogThinkingPolicies({
        catalog,
        providers: pluginRegistry.providers,
        metadataSnapshot: createPluginMetadataSnapshotFixture(),
      });
      return createPreparedGatewayModelCatalog({ ...catalog, pluginRegistry });
    };
    const modelCatalog = new Map([
      ["main", prepare(false)],
      ["work", prepare(true)],
    ]);
    const rowContext = buildSessionListRowMetadataContext({ now: 1 });
    const cases = [
      ["main", "reasoner", "openclaw", "high"],
      ["main", "alternate", "openclaw", "low"],
      ["main", "reasoner", "codex", "low"],
      ["work", "reasoner", "openclaw", "low"],
      ["main", "reasoner", "openclaw", "high"],
    ] as const;
    for (const [index, [agentId, model, runtime, expected]] of cases.entries()) {
      const result = readSessionRowInputs({
        cfg,
        agentId,
        key: `agent:${agentId}:scoped-${index}`,
        store: {},
        storePath: "unused",
        rowContext,
        modelCatalog,
        activeModel: null,
        skipTranscriptUsageFallback: true,
        entry: {
          sessionId: `scoped-${index}`,
          updatedAt: 1,
          providerOverride: provider,
          modelOverride: model,
          thinkingLevel: "medium",
          acp: {
            backend: runtime,
            agent: "fixture",
            runtimeSessionName: `scoped-${index}`,
            mode: "oneshot",
            state: "idle",
            lastActivityAt: 1,
          },
        },
      });
      expect(result.inputs.thinkingProjection).toMatchObject({
        thinkingLevel: expected,
        effectiveThinkingLevel: expected,
        thinkingDefault: expected,
        thinkingOptions:
          expected === "high" ? ["Off", "High", "Low", "ultra"] : ["Off", "Low", "High", "ultra"],
      });
    }
  });
});

test("rebuilds resident thinking facts on config and catalog publication", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    const fixture = createRowThinkingFixture();
    let cfg = fixture.cfg;
    let catalog = fixture.modelCatalog;
    const key = "agent:main:thinking-publication";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId: "thinking-publication",
        updatedAt: 1,
        modelProvider: fixture.provider,
        model: "reasoner",
        thinkingLevel: "medium",
      },
    );
    const projection = await createSessionRowProjection({
      cfg,
      getConfig: () => cfg,
      getModelCatalog: async () => catalog,
    });
    const read = () => projection.snapshot({ agentId: "main", key }).row;
    try {
      await projection.ensureMaterialized();
      expect(read()).toMatchObject({ thinkingLevel: "high", thinkingDefault: "off" });
      const initialCalls = fixture.policyCalls();
      cfg = {
        ...cfg,
        agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, thinkingDefault: "high" } },
      };
      expect(read()?.thinkingDefault).toBe("off");
      sessionChanges.emit({ all: true, scope: "config" });
      await projection.ensureMaterialized();
      expect(read()).toMatchObject({ thinkingLevel: "high", thinkingDefault: "high" });
      expect(fixture.policyCalls()).toBeGreaterThan(initialCalls);
      const configuredCalls = fixture.policyCalls();
      const next: ModelCatalogSnapshot = {
        entries: [
          { provider: fixture.provider, id: "reasoner", name: "Reasoner", reasoning: false },
        ],
        routeVariants: [],
      };
      prepareModelCatalogThinkingPolicies({
        catalog: next,
        providers: fixture.pluginRegistry.providers,
        metadataSnapshot: createPluginMetadataSnapshotFixture(),
      });
      catalog = new Map([
        [
          "main",
          createPreparedGatewayModelCatalog({ ...next, pluginRegistry: fixture.pluginRegistry }),
        ],
      ]);
      expect(read()?.thinkingLevel).toBe("high");
      notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
      await projection.ensureMaterialized();
      expect(read()).toMatchObject({
        thinkingLevel: "off",
        thinkingDefault: "off",
        thinkingOptions: ["off", "ultra"],
      });
      expect(fixture.policyCalls()).toBeGreaterThan(configuredCalls);
    } finally {
      projection.dispose();
    }
  });
});

test.each([
  { search: undefined, recordedModel: false },
  { search: undefined, recordedModel: true },
  { search: "unmatched-runtime-search", recordedModel: false },
  { search: "unmatched-runtime-search", recordedModel: true },
  { search: "list-model", recordedModel: false },
])(
  "reuses prepared metadata across session rows (search=$search, recordedModel=$recordedModel)",
  async ({ search, recordedModel }) => {
    await withStateDirEnv("openclaw-prepared-row-auth-", async ({ stateDir }) => {
      resetPluginRuntimeStateForTest();
      const pluginRegistry = createEmptyPluginRegistry();
      setActivePluginRegistry(pluginRegistry);
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: { model: "example/list-alias", thinkingDefault: "off" },
        },
      };
      resetConfigRuntimeState();
      setRuntimeConfigSnapshot(cfg);
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "list-model-owner",
            modelIdNormalization: {
              providers: { example: { aliases: { "list-alias": "list-model" } } },
            },
          },
        ],
      });
      const modelCatalog = new Map([
        [
          "main",
          createPreparedGatewayModelCatalog({
            entries: [{ provider: "example", id: "list-model", name: "Synthetic model" }],
            pluginRegistry,
            metadataSnapshot,
          }),
        ],
      ]);
      const metadata = await import("../plugins/current-plugin-metadata-snapshot.js");
      const lookup = vi.spyOn(metadata, "getCurrentPluginMetadataSnapshot");
      const project = async (count: number) => {
        const store: Record<string, SessionEntry> = Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `agent:main:dashboard:prepared-${index}`,
            {
              sessionId: `prepared-${index}`,
              updatedAt: index + 1,
              displayName: `Session ${index}`,
              ...(recordedModel ? { modelProvider: "example", model: "list-model" } : {}),
            },
          ]),
        );
        lookup.mockClear();
        const result = await listSessionFixture({
          cfg,
          store,
          storePath: path.join(stateDir, "sessions.json"),
          modelCatalog,
          opts: { limit: count, ...(search ? { search } : {}) },
        });
        expect(result.count).toBe(search === "unmatched-runtime-search" ? 0 : count);
        expect(result.defaults.model).toBe("list-model");
        expect(result.sessions.every((session) => session.model === "list-model")).toBe(true);
        return lookup.mock.calls.length;
      };
      try {
        await project(1);
        const small = await project(16);
        const large = await project(128);
        expect(large).toBeLessThanOrEqual(small + 4);
      } finally {
        lookup.mockRestore();
      }
    });
  },
);
