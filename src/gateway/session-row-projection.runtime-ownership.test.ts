import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { AgentHarnessPreflightError } from "../agents/harness/errors.js";
import type { AgentHarness } from "../agents/harness/types.js";
import { harnessRegistry } from "../agents/model-catalog-fixtures.test-support.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { beginPluginStatePublication } from "../plugin-state/plugin-state-publication.js";
import { createPluginStateKeyedStoreV2 } from "../plugin-state/plugin-state-store.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createPreparedGatewayModelCatalog } from "./server-model-catalog-view.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import {
  createTestProjection,
  holdForeground,
} from "./session-row-projection.read-fixture.test-support.js";
import { requestSessionRow } from "./session-row-projection.test-support.js";
import { listProjectedSessions } from "./session-utils-list.js";

// Hold GatewayScheduler timeouts so WAL maintenance stays outside the request SQL budget.
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const nativeOwnership = (model: string, provider = "openai") => ({
  model: "native" as const,
  auth: "native" as const,
  modelRef: { provider, model },
});

function withoutSql(run: () => void) {
  const sql = observeHostDataSql();
  try {
    run();
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
}

function nativeHarness(
  resolve: NonNullable<AgentHarness["resolveSessionRuntimeOwnershipAsync"]>,
  sync?: AgentHarness["resolveSessionRuntimeOwnership"],
) {
  const previous = captureActivePluginRegistrySnapshot();
  const registry = harnessRegistry("row-native", {
    resolveSessionRuntimeOwnershipAsync: resolve,
    ...(sync ? { resolveSessionRuntimeOwnership: sync } : {}),
  });
  setActivePluginRegistry(registry);
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "row-native", activation: { onAgentHarnesses: ["row-native"] } }],
  });
  return {
    registry,
    metadataSnapshot,
    [Symbol.dispose]: () => restoreActivePluginRegistrySnapshot(previous),
  };
}

const defaultConfig = {
  agents: { entries: { main: {} }, defaults: { model: { primary: "openai/gpt-5.5" } } },
};

function seedNative(key: string, sessionId: string, extra: Partial<SessionEntry> = {}) {
  const entry = {
    sessionId,
    updatedAt: 1,
    agentHarnessId: "row-native",
    modelSelectionLocked: true,
    ...extra,
  };
  replaceSessionEntrySync({ agentId: "main", sessionKey: key }, entry);
  return entry;
}

function catalogFor(
  config: OpenClawConfig,
  native: ReturnType<typeof nativeHarness>,
  id: string,
  name = id,
) {
  const catalog = createPreparedGatewayModelCatalog({
    config,
    entries: [{ provider: "example", id, name }],
    pluginRegistry: native.registry,
    metadataSnapshot: native.metadataSnapshot,
  });
  return new Map([["main", catalog]]);
}

function expectListed(respond: ReturnType<typeof vi.fn>, sessions: Record<string, unknown>[]) {
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      sessions: sessions.map((row) => expect.objectContaining(row)),
    }),
  );
}

it("rereads native model ownership after its harness plugin config changes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:harness:row-native:config";
    const bindings = createPluginStateKeyedStoreV2<string>(
      "row-native",
      { namespace: "config-bindings", maxEntries: 10 },
      { assertCurrent() {} },
    );
    await bindings.register(key, "present");
    seedNative(key, "native-config");
    const config = (model: string): OpenClawConfig => ({
      agents: { entries: { main: {} }, defaults: { model: "example/fallback" } },
      plugins: { entries: { "row-native": { enabled: true, config: { model } } } },
    });
    let cfg = config("original-native");
    using configState = { [Symbol.dispose]: resetConfigRuntimeState };
    void configState;
    setRuntimeConfigSnapshot(cfg);
    using native = nativeHarness(async (params) => {
      await bindings.lookup(params.sessionKey!);
      return nativeOwnership(String(cfg.plugins!.entries!["row-native"]!.config!.model), "example");
    });
    const view = () => catalogFor(cfg, native, "fallback", "Fallback");
    let catalog = view();
    using _ = holdForeground();
    using projection = await createTestProjection({
      cfg,
      getConfig: () => cfg,
      getModelCatalog: async () => catalog,
    });
    const listedModel = async () =>
      (await listProjectedSessions({ projection, opts: {} })).sessions[0]?.model;
    expect(await listedModel()).toBe("original-native");
    cfg = config("replacement-native");
    setRuntimeConfigSnapshot(cfg);
    catalog = view();
    notifyPreparedModelRuntimePublication({ phase: "published" });
    await projection.ensureMaterialized();
    expect(await listedModel()).toBe("replacement-native");
  });
});

it("keeps archived native sessions searchable after catalog replacement", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = {
      agents: { entries: { main: {} }, defaults: { model: "example/fallback" } },
    };
    const archivedKey = "agent:main:harness:row-native:archived";
    seedNative(archivedKey, "archived-native", { archivedAt: 1 });
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:dashboard:scheduled-target" },
      { sessionId: "scheduled-target", updatedAt: 2 },
    );
    let nativeModel = "original-native";
    using native = nativeHarness(async () => nativeOwnership(nativeModel, "example"));
    using _ = holdForeground();
    using projection = await createTestProjection({
      cfg,
      getModelCatalog: async () => catalogFor(cfg, native, nativeModel),
    });
    const respond = vi.fn();
    const list = async (search?: string, archived: boolean | "all" = "all") => {
      respond.mockClear();
      await requestSessionRow(
        sessionReadHandlers["sessions.list"]!,
        bindSessionRowProjection(requestContext(cfg), () => projection!),
        "sessions.list",
        { agentId: "main", search, archived, limit: 5, includeLastMessage: false },
        respond,
      );
    };
    await list(undefined, true);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessions: expect.arrayContaining([
          expect.objectContaining({ sessionId: "archived-native", model: "original-native" }),
        ]),
      }),
    );
    await list("scheduled-target");
    const expectTarget = () => expectListed(respond, [{ sessionId: "scheduled-target" }]);
    expectTarget();
    nativeModel = "replacement-native";
    notifyPreparedModelRuntimePublication({ phase: "published" });
    await projection.ensureMaterialized();
    await list("scheduled-target");
    expectTarget();
    await list("replacement-native");
    expectListed(respond, [{ sessionId: "archived-native", model: "replacement-native" }]);
  });
});

it.for(["change", "failure"] as const)(
  "keeps native ownership changes local to one listed row: %s",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = defaultConfig;
      const key = "agent:main:harness:row-native:changing";
      seedNative(key, "changing", { updatedAt: 2 });
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:dashboard:unaffected" },
        { sessionId: "unaffected", updatedAt: 1 },
      );
      const failure = new AgentHarnessPreflightError("Synthetic native read failure");
      let reads = 0;
      let changing = false;
      using native = nativeHarness(async (params) => {
        reads++;
        if (changing && change === "failure") {
          throw failure;
        }
        if (changing) {
          const registration = native.registry.agentHarnesses[0]!;
          registration.harness = { ...registration.harness };
          params.assertCurrent?.();
        }
        return nativeOwnership("gpt-5.6-sol");
      });
      using _ = holdForeground();
      using projection = await createTestProjection({ cfg, modelCatalog: [] });
      await projection.ensureMaterialized();
      expect(projection.needsMaterialization).toBe(false);
      const initialReads = reads;
      withoutSql(() => {
        expect(projection.snapshot({ agentId: "main", key })).toEqual({ row: null });
        expect(reads).toBe(initialReads);
      });
      expect((await listProjectedSessions({ projection, opts: {} })).sessions[0]).toMatchObject({
        sessionId: "changing",
        model: "gpt-5.6-sol",
      });
      changing = true;
      reads = 0;
      sessionChanges.emit({ agentId: "main", sessionKey: key, factsInvalidated: true });
      const respond = vi.fn();
      const list = (id: string) =>
        requestSessionRow(
          sessionReadHandlers["sessions.list"]!,
          bindSessionRowProjection(requestContext(cfg), () => projection!),
          "sessions.list",
          {},
          respond,
          null,
          id,
        );
      const request = list("ownership-change-list");
      if (change === "failure") {
        await expect(request).rejects.toBe(failure);
        expect(respond).not.toHaveBeenCalled();
      } else {
        await request;
        const expectModels = (model: string) =>
          expectListed(respond, [{ sessionId: "changing", model }, { sessionId: "unaffected" }]);
        expectModels("gpt-5.5");
        expect(reads).toBe(1);
        changing = false;
        respond.mockClear();
        await list("ownership-stable-list");
        expectModels("gpt-5.5");
        expect(reads).toBe(1);

        sessionChanges.emit({ agentId: "main", sessionKey: key, factsInvalidated: true });
        respond.mockClear();
        await list("ownership-invalidated-list");
        expectModels("gpt-5.6-sol");
        expect(reads).toBe(2);
      }
    });
  },
);

it("prepares native model ownership in workers and invalidates only its committed binding", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:harness:row-native:session";
    const bindings = createPluginStateKeyedStoreV2<string>(
      "row-native",
      { namespace: "bindings", maxEntries: 10 },
      { assertCurrent() {} },
    );
    await bindings.register(key, "gpt-5.6-sol");
    const entry = seedNative(key, "row-native-session");
    let ownershipReads = 0;
    const syncOwnership = vi.fn(() => {
      throw new Error("Native row ownership must be read asynchronously");
    });
    using native = nativeHarness(async (params) => {
      ownershipReads++;
      const model = await bindings.lookup(params.sessionKey!);
      return model ? nativeOwnership(model) : undefined;
    }, syncOwnership);
    using _ = holdForeground();
    void native;
    using projection = await createTestProjection({ cfg: defaultConfig, modelCatalog: [] });
    await projection.ensureMaterialized();
    const snapshot = () => projection!.snapshot({ agentId: "main", key }).row;
    snapshot();
    const initialRevision = snapshot()?.sessionModelRevision;
    expect(initialRevision).toEqual(expect.any(String));
    const expectModel = (model: string) =>
      expect(snapshot()).toMatchObject({ modelProvider: "openai", model });
    withoutSql(() => {
      expectModel("gpt-5.6-sol");
      expectModel("gpt-5.6-sol");
    });
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      { ...entry, label: "Renamed native session", updatedAt: 2, lastReadAt: 2 },
    );
    await projection.ensureMaterialized();
    expect(snapshot()).toMatchObject({
      label: "Renamed native session",
      sessionModelRevision: initialRevision,
    });
    const initialReads = ownershipReads;
    const source = projection.capture({ agentId: "main", key })?.runtimeOwnershipDependencies?.[0]
      ?.identity;
    expect(source).toBeDefined();
    const pending = beginPluginStatePublication(() => source!);
    try {
      await projection.ensureMaterialized();
      expect(snapshot()?.model).toBe("gpt-5.6-sol");
      expect(ownershipReads).toBe(initialReads);
    } finally {
      pending.finish("completed");
    }
    await bindings.register("unrelated", "gpt-5.6-luna");
    await projection.ensureMaterialized();
    expect(ownershipReads).toBe(initialReads);
    expect(snapshot()?.sessionModelRevision).toBe(initialRevision);
    const saved = projection.capture({ agentId: "main", key })?.entry;
    await bindings.register(key, "gpt-5.6-luna");
    await projection.ensureMaterialized();
    expectModel("gpt-5.6-luna");
    const changedRevision = snapshot()?.sessionModelRevision;
    expect(changedRevision).toEqual(expect.any(String));
    expect(changedRevision).not.toBe(initialRevision);
    expect(projection.capture({ agentId: "main", key })?.entry).toEqual(saved);
    await bindings.delete(key);
    await projection.ensureMaterialized();
    expectModel("gpt-5.5");
    const removedRevision = snapshot()?.sessionModelRevision;
    expect(removedRevision).toEqual(expect.any(String));
    expect(removedRevision).not.toBe(changedRevision);
    const beforeUnknown = ownershipReads;
    beginPluginStatePublication(() => source!).finish("unknown");
    await projection.ensureMaterialized();
    expect(ownershipReads).toBeGreaterThan(beforeUnknown);
    expect(snapshot()?.model).toBe("gpt-5.5");
    expect(snapshot()?.sessionModelRevision).toBe(removedRevision);
    expect(syncOwnership).not.toHaveBeenCalled();
  });
});
