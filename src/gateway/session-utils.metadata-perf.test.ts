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
import type { ProviderThinkingProfile } from "../plugins/provider-thinking.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPreparedGatewayModelCatalog } from "./server-model-catalog-view.js";
import { listSessionFixture } from "./session-list.test-support.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import { readSessionRowInputs } from "./session-utils-row.js";

function createRowThinkingFixture(runtimeRoute = false) {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
  const provider = "row-thinking-fixture";
  const model = { provider, id: "reasoner", name: "Reasoner" };
  const cfg: OpenClawConfig = {
    agents: {
      entries: { main: {} },
      defaults: { model: `${provider}/reasoner`, thinkingDefault: "off", utilityModel: "" },
    },
  };
  const policy = vi.fn((): ProviderThinkingProfile => ({
    levels: [
      { id: "off", label: "Off", rank: 0 },
      { id: "high", label: "Deep", rank: 10 },
      { id: "low", label: "Light", rank: 40 },
    ],
    defaultLevel: "low",
  }));
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.providers.push({
    pluginId: provider,
    source: "test",
    provider: { id: provider, label: provider, auth: [], resolveThinkingProfile: policy },
  });
  const catalog: ModelCatalogSnapshot = {
    entries: [{ ...model, reasoning: true }],
    routeVariants: runtimeRoute ? [{ ...model, reasoning: true, nativeRuntime: "openclaw" }] : [],
  };
  const wrap = (snapshot: Parameters<typeof createPreparedGatewayModelCatalog>[0]) =>
    new Map([["main", createPreparedGatewayModelCatalog({ ...snapshot, pluginRegistry })]]);
  const prepare = (snapshot: ModelCatalogSnapshot) => {
    prepareModelCatalogThinkingPolicies({
      catalog: snapshot,
      pluginRegistry,
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
    });
    return wrap(snapshot);
  };
  const modelCatalog = prepare(catalog);
  const rowContext = buildSessionListRowMetadataContext({ now: 1 });
  const entry = (sessionId: string, thinkingLevel: SessionEntry["thinkingLevel"]) => ({
    sessionId,
    updatedAt: 1,
    modelProvider: provider,
    model: "reasoner",
    thinkingLevel,
  });
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
      entry: entry(`thinking-${index}`, thinkingLevel),
      preparedAcpMeta: {
        backend: "openclaw",
        agent: "fixture",
        runtimeSessionName: `thinking-${index}`,
        mode: "oneshot",
        state: "idle",
        lastActivityAt: 1,
      },
      modelCatalog: models,
      rowContext,
      activeModel: null,
    }).inputs.thinkingProjection;
  return {
    cfg,
    policyCalls: () => policy.mock.calls.length,
    catalog,
    modelCatalog,
    model,
    prepare,
    wrap,
    entry,
    read,
  };
}

test.each(["missing", "identity-only", "runtime-route"] as const)(
  "preserves a stored level with a %s catalog after warming thinking facts",
  async (kind) => {
    await withStateDirEnv("openclaw-row-thinking-incomplete-", async () => {
      const fixture = createRowThinkingFixture(kind === "runtime-route");
      const warmed = fixture.read(
        undefined,
        kind === "missing" ? fixture.catalog.entries : fixture.modelCatalog,
      );
      if (kind === "runtime-route") {
        expect(warmed.catalogEntry?.nativeRuntime).toBe("openclaw");
      }
      const warmCalls = fixture.policyCalls();
      const catalog =
        kind === "missing"
          ? undefined
          : fixture.wrap({
              entries: kind === "identity-only" ? [fixture.model] : [],
            });
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

test("rebuilds resident thinking facts on config and catalog publication", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const fixture = createRowThinkingFixture();
    let cfg = fixture.cfg;
    let catalog = fixture.modelCatalog;
    const key = "agent:main:thinking-publication";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      fixture.entry("thinking-publication", "medium"),
    );
    const projection = await createSessionRowProjection({
      cfg,
      getConfig: () => cfg,
      getModelCatalog: async () => catalog,
    });
    using _ = { [Symbol.dispose]: () => projection.dispose() };
    const read = () => projection.snapshot({ agentId: "main", key }).row;
    await projection.ensureMaterialized();
    expect(read()).toMatchObject({ thinkingLevel: "medium", thinkingDefault: "off" });
    const initialCalls = fixture.policyCalls();
    cfg = {
      ...cfg,
      agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, thinkingDefault: "high" } },
    };
    expect(read()?.thinkingDefault).toBe("off");
    sessionChanges.emit({ all: true, scope: "config" });
    await projection.ensureMaterialized();
    expect(read()).toMatchObject({ thinkingLevel: "medium", thinkingDefault: "high" });
    expect(fixture.policyCalls()).toBeGreaterThan(initialCalls);
    const configuredCalls = fixture.policyCalls();
    catalog = fixture.prepare({
      entries: [{ ...fixture.model, reasoning: false }],
      routeVariants: [],
    });
    expect(read()?.thinkingLevel).toBe("medium");
    notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
    await projection.ensureMaterialized();
    expect(read()).toMatchObject({
      thinkingLevel: "medium",
      thinkingDefault: "off",
      thinkingOptions: ["off", "ultra"],
    });
    expect(fixture.policyCalls()).toBeGreaterThan(configuredCalls);
  });
});

test.each([
  { search: undefined, recordedModel: true },
  { search: "unmatched-runtime-search", recordedModel: false },
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
      const catalog = createPreparedGatewayModelCatalog({
        entries: [{ provider: "example", id: "list-model", name: "Synthetic model" }],
        pluginRegistry,
        metadataSnapshot,
      });
      const modelCatalog = new Map([["main", catalog]]);
      const metadata = await import("../plugins/current-plugin-metadata-snapshot.js");
      using lookup = vi.spyOn(metadata, "getCurrentPluginMetadataSnapshot");
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
      await project(1);
      const small = await project(16);
      const large = await project(128);
      expect(large).toBeLessThanOrEqual(small + 4);
    });
  },
);
