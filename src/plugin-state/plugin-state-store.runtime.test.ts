// Plugin state runtime tests cover runtime-backed plugin state storage.
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import { resolveStateDir } from "../config/paths.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { markPluginRegistryActive, revokePluginRecord } from "../plugins/registry-lifecycle.js";
import type { PluginRecord } from "../plugins/registry-types.js";
import { createPluginRegistry } from "../plugins/registry.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetPluginBlobStoreForTests, type OpenBlobStoreOptions } from "./plugin-blob-store.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";

function createPluginRecord(
  id: string,
  origin: PluginRecord["origin"] = "bundled",
  opts: { trustedOfficialInstall?: boolean } = {},
): PluginRecord {
  return {
    id,
    name: id,
    source: `/plugins/${id}/index.ts`,
    origin,
    trustedOfficialInstall: opts.trustedOfficialInstall,
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    cliBackendIds: [],
    providerIds: [],
    embeddingProviderIds: [],
    speechProviderIds: [],
    realtimeTranscriptionProviderIds: [],
    realtimeVoiceProviderIds: [],
    mediaUnderstandingProviderIds: [],
    transcriptSourceProviderIds: [],
    imageGenerationProviderIds: [],
    videoGenerationProviderIds: [],
    musicGenerationProviderIds: [],
    webFetchProviderIds: [],
    webSearchProviderIds: [],
    migrationProviderIds: [],
    agentHarnessIds: [],
    cliCommands: [],
    services: [],
    gatewayDiscoveryServiceIds: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  } as PluginRecord;
}

function createTestPluginRegistry() {
  return createPluginRegistry({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {
      state: {
        resolveStateDir,
        openBlobStore: () => {
          throw new Error("registry plugin runtime proxy should bind openBlobStore");
        },
        openKeyedStore: () => {
          throw new Error("registry plugin runtime proxy should bind openKeyedStore");
        },
        openSyncKeyedStore: () => {
          throw new Error("registry plugin runtime proxy should bind openSyncKeyedStore");
        },
      },
    } as unknown as PluginRuntime,
  });
}

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  resetPluginBlobStoreForTests();
  resetPluginStateStoreForTests();
});

describe("plugin runtime state proxy", () => {
  it("binds openKeyedStore to the bundled plugin id and keeps resolveStateDir", async () => {
    await withOpenClawTestState({ label: "plugin-state-runtime" }, async (state) => {
      const registry = createTestPluginRegistry();
      const record = createPluginRecord("discord", "bundled");
      registry.registry.plugins.push(record);
      const api = registry.createApi(record, { config: {} });

      expect(api.runtime.state.resolveStateDir()).toBe(state.stateDir);
      const observation = observeHostDataSql(state.env);
      const sql = observation.calls;
      try {
        const store = api.runtime.state.openKeyedStore<{ plugin: string }>({
          namespace: "runtime",
          maxEntries: 10,
        });
        await expect(store.registerIfAbsent("k", { plugin: "discord" })).resolves.toBe(true);
        await expect(store.registerIfAbsent("k", { plugin: "duplicate" })).resolves.toBe(false);

        const telegram = createPluginRecord("telegram", "bundled");
        registry.registry.plugins.push(telegram);
        const telegramApi = registry.createApi(telegram, { config: {} });
        const telegramStore = telegramApi.runtime.state.openKeyedStore<{ plugin: string }>({
          namespace: "runtime",
          maxEntries: 10,
        });
        await expect(telegramStore.lookup("k")).resolves.toBeUndefined();
        await expect(telegramStore.count?.()).resolves.toBe(0);
        await expect(store.count?.()).resolves.toBe(1);
        await expect(telegramStore.lookupMany?.(["k"])).resolves.toEqual([
          { ok: true, value: undefined },
        ]);
        await expect(store.lookupMany?.(["k", "missing", "k"])).resolves.toEqual([
          { ok: true, value: { plugin: "discord" } },
          { ok: true, value: undefined },
          { ok: true, value: { plugin: "discord" } },
        ]);
        await expect(store.lookup("k")).resolves.toEqual({ plugin: "discord" });

        await store.register("temporary", { plugin: "discord" });
        await expect(store.consume("temporary")).resolves.toEqual({ plugin: "discord" });
        await store.register("deleted", { plugin: "discord" });
        await expect(store.delete("deleted")).resolves.toBe(true);
        await telegramStore.register("retained", { plugin: "telegram" });
        await store.clear();
        await expect(store.entries()).resolves.toEqual([]);
        await expect(telegramStore.lookup("retained")).resolves.toEqual({ plugin: "telegram" });
        for (const method of sql) {
          expect(method).not.toHaveBeenCalled();
        }
      } finally {
        observation.restore();
      }

      const syncStore = api.runtime.state.openSyncKeyedStore<{ plugin: string }>({
        namespace: "sync-runtime",
        maxEntries: 10,
      });
      expect(syncStore.registerIfAbsent("k", { plugin: "discord" })).toBe(true);
      expect(syncStore.lookup("k")).toEqual({ plugin: "discord" });
      expect(syncStore.lookupMany?.(["k", "missing"])).toEqual([
        { ok: true, value: { plugin: "discord" } },
        { ok: true, value: undefined },
      ]);
    });
  });

  it("allows trusted official global plugins to use keyed state", async () => {
    await withOpenClawTestState({ label: "plugin-state-trusted-global" }, async () => {
      const registry = createTestPluginRegistry();
      const record = createPluginRecord("slack", "global", { trustedOfficialInstall: true });
      registry.registry.plugins.push(record);
      const api = registry.createApi(record, { config: {} });

      const store = api.runtime.state.openKeyedStore<{ plugin: string }>({
        namespace: "runtime",
        maxEntries: 10,
      });
      await expect(store.register("thread", { plugin: "slack" })).resolves.toBeUndefined();
      await expect(store.lookup("thread")).resolves.toEqual({ plugin: "slack" });
    });
  });

  it("fences retained operations and range reads when the owning plugin closes", async () => {
    await withOpenClawTestState({ label: "plugin-retained-runtime-closure" }, async () => {
      const registry = createTestPluginRegistry();
      const record = createPluginRecord("history-owner");
      registry.registry.plugins.push(record);
      markPluginRegistryActive(registry.registry);
      const api = registry.createApi(record, { config: {} });
      const sourceOptions = { namespace: "history", maxEntries: 10 };
      const retainedOptions = { namespace: "history", retention: "retained" as const };
      const source = api.runtime.state.openKeyedStore<number>(sourceOptions);
      const retained = api.runtime.state.openKeyedStore<number>(retainedOptions);
      await source.register("legacy", 1);
      await retained.register("current", 2);
      const observed = await retained.observe!("current");
      const range = { keyStartInclusive: "a", keyEndExclusive: "z", limit: 10 };
      const detachedRead = retained.entriesInKeyRange!;
      const pendingMove = retained.moveEntriesFrom!({
        namespace: "history",
        entries: [{ sourceKey: "legacy", targetKey: "promoted" }],
      });
      revokePluginRecord(registry.registry, record);
      await expect(pendingMove).rejects.toThrow();
      for (const operation of [
        () => retained.register("denied", 3),
        () => retained.registerIfAbsent("denied", 3),
        () => retained.observe!("current"),
        () =>
          retained.compareAndApply!("current", observed.comparison, {
            operation: "update",
            action: "set",
            value: 3,
          }),
        () => retained.update!("current", () => 3),
        () => retained.deleteIf!("current", () => true),
        () => retained.deleteIfEqual!("current", 2),
        () => retained.lookup("current"),
        () => retained.lookupMany!(["current"]),
        () => retained.consume("current"),
        () => retained.delete("current"),
        () => retained.entries(),
        () => retained.count!(),
        () => retained.clear(),
        () => detachedRead(range),
        () => source.entriesInKeyRange!(range),
      ]) {
        await expect(operation()).rejects.toThrow();
      }
      expect(() => api.runtime.state.openKeyedStore(retainedOptions)).toThrow();
      const canonicalSource = createPluginStateKeyedStore<number>(record.id, sourceOptions);
      const canonicalRetained = createPluginStateKeyedStore<number>(record.id, retainedOptions);
      expect(await canonicalSource.lookup("legacy")).toBe(1);
      expect(await canonicalRetained.lookup("current")).toBe(2);
      expect(await canonicalRetained.lookup("promoted")).toBeUndefined();
      expect(await canonicalRetained.lookup("denied")).toBeUndefined();
    });
  });

  it.each([true, false])(
    "fences revoked ingress reads, admission, and recovery (policy=%s)",
    async (policy) => {
      await withOpenClawTestState({ label: "plugin-ingress-runtime-closure" }, async (state) => {
        const registry = createTestPluginRegistry();
        const record = createPluginRecord("ingress-owner");
        registry.registry.plugins.push(record);
        markPluginRegistryActive(registry.registry);
        const api = registry.createApi(record, { config: {} });
        const queue = api.runtime.state.openChannelIngressQueue<{ text: string }>({
          now: () => 10,
        });
        await queue.enqueue("claimed", { text: "retained" });
        const claimed = await queue.claim("claimed", { ownerId: "previous" });
        expect(claimed).not.toBeNull();
        const entered = createDeferredCore();
        const releasePolicy = createDeferredCore<boolean>();
        const recovering = queue.recoverStaleClaims({
          now: 20,
          staleMs: 5,
          shouldRecover: () => {
            entered.resolve();
            return releasePolicy.promise;
          },
        });
        try {
          await entered.promise;
          const listing = queue.listClaims();
          const admission = queue.enqueue("denied", { text: "revoked" });
          revokePluginRecord(registry.registry, record);
          releasePolicy.resolve(policy);
          await Promise.all([
            expect(recovering).rejects.toThrow(
              'Plugin "ingress-owner" runtime is no longer active',
            ),
            expect(listing).rejects.toThrow('Plugin "ingress-owner" runtime is no longer active'),
            expect(admission).rejects.toThrow('Plugin "ingress-owner" runtime is no longer active'),
          ]);
          const maintenance = createChannelIngressQueue({
            channelId: record.id,
            stateDir: state.stateDir,
          });
          expect(await maintenance.listClaims()).toEqual([claimed]);
          expect(await maintenance.listPending()).toEqual([]);
        } finally {
          releasePolicy.resolve(false);
          await recovering.catch(() => {});
        }
      });
    },
  );

  it.each(
    (["enqueue", "recovery"] as const).flatMap((operation) =>
      (["before", "after"] as const).map((revocation) => ({ operation, revocation })),
    ),
  )(
    "settles ingress $operation when its owner is revoked $revocation the commit grant",
    async ({ operation, revocation }) => {
      await withOpenClawTestState({ label: "plugin-ingress-commit-authority" }, async (state) => {
        const registry = createTestPluginRegistry();
        const record = createPluginRecord("ingress-owner");
        registry.registry.plugins.push(record);
        markPluginRegistryActive(registry.registry);
        const api = registry.createApi(record, { config: {} });
        const queue = api.runtime.state.openChannelIngressQueue<{ text: string }>({
          now: () => 10,
        });
        await queue.enqueue("retained", { text: "retained" });
        const claimed = await queue.claim("retained", { ownerId: "previous" });
        expect(claimed).not.toBeNull();
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        const stages: string[] = [];
        const admission = vi
          .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit, attachment) =>
            createAdmission((request, grant) => {
              stages.push(request.stage);
              if (request.stage === "commit" && revocation === "before") {
                revokePluginRecord(registry.registry, record);
              }
              admit(request, grant);
              if (request.stage === "commit" && revocation === "after") {
                revokePluginRecord(registry.registry, record);
              }
            }, attachment),
          );
        try {
          const writing =
            operation === "enqueue"
              ? queue.enqueue("admitted", { text: "new event" })
              : queue.recoverStaleClaims({ now: 20, staleMs: 5 });
          if (revocation === "before") {
            await expect(writing).rejects.toThrow(
              'Plugin "ingress-owner" runtime is no longer active',
            );
          } else if (operation === "enqueue") {
            await expect(writing).resolves.toMatchObject({
              kind: "accepted",
              duplicate: false,
              record: { id: "admitted" },
            });
          } else {
            await expect(writing).resolves.toBe(1);
          }
          expect(stages).toEqual(["transaction", "commit"]);
          const inspector = createChannelIngressQueue({
            channelId: record.id,
            stateDir: state.stateDir,
            access: "read-only",
          });
          expect((await inspector.listPending()).map((row) => row.id)).toEqual(
            revocation === "before" ? [] : [operation === "enqueue" ? "admitted" : "retained"],
          );
          expect(await inspector.listClaims()).toEqual(
            operation === "recovery" && revocation === "after" ? [] : [claimed],
          );
        } finally {
          admission.mockRestore();
        }
      });
    },
  );

  it("binds blob stores to the trusted plugin id", async () => {
    await withOpenClawTestState({ label: "plugin-blob-runtime" }, async () => {
      const registry = createTestPluginRegistry();
      const record = createPluginRecord("diffs", "global", { trustedOfficialInstall: true });
      registry.registry.plugins.push(record);
      const api = registry.createApi(record, { config: {} });

      const store = api.runtime.state.openBlobStore<{ kind: string }>({
        namespace: "runtime",
        maxEntries: 10,
        maxBytesPerEntry: 1024,
        maxBytesPerNamespace: 4096,
      });
      await expect(
        store.registerIfAbsent("viewer", new Uint8Array([1, 2, 3]), { kind: "viewer" }),
      ).resolves.toBe(true);
      await expect(store.lookup("viewer")).resolves.toMatchObject({
        key: "viewer",
        metadata: { kind: "viewer" },
        sizeBytes: 3,
      });

      const otherRecord = createPluginRecord("other", "bundled");
      registry.registry.plugins.push(otherRecord);
      const otherStore = registry
        .createApi(otherRecord, { config: {} })
        .runtime.state.openBlobStore<{ kind: string }>({
          namespace: "runtime",
          maxEntries: 10,
          maxBytesPerEntry: 1024,
          maxBytesPerNamespace: 4096,
        });
      await expect(otherStore.lookup("viewer")).resolves.toBeUndefined();
    });
  });

  it("keeps blob and keyed namespace option policies independent", async () => {
    await withOpenClawTestState({ label: "plugin-state-policy-independence" }, async () => {
      const registry = createTestPluginRegistry();
      const record = createPluginRecord("diffs", "bundled");
      registry.registry.plugins.push(record);
      const state = registry.createApi(record, { config: {} }).runtime.state;

      const blob = state.openBlobStore({
        namespace: "shared-policy",
        maxEntries: 2,
        maxBytesPerEntry: 8,
        maxBytesPerNamespace: 16,
        overflowPolicy: "reject-new",
        defaultTtlMs: 100,
      });
      const keyed = state.openKeyedStore({
        namespace: "shared-policy",
        maxEntries: 3,
        overflowPolicy: "evict-oldest",
        defaultTtlMs: 200,
      });

      await expect(blob.register("blob", new Uint8Array([1]), {})).resolves.toBeUndefined();
      await expect(keyed.register("keyed", { ok: true })).resolves.toBeUndefined();
    });
  });

  it("ignores plugin-supplied state directory overrides", async () => {
    await withOpenClawTestState({ label: "plugin-blob-runtime-env" }, async (state) => {
      const registry = createTestPluginRegistry();
      const record = createPluginRecord("diffs", "global", { trustedOfficialInstall: true });
      registry.registry.plugins.push(record);
      const api = registry.createApi(record, { config: {} });
      const redirectedEnv = {
        ...state.env,
        OPENCLAW_STATE_DIR: `${state.stateDir}-redirected`,
      };

      const store = api.runtime.state.openBlobStore<{ kind: string }>({
        namespace: "runtime-env",
        maxEntries: 10,
        maxBytesPerEntry: 1024,
        maxBytesPerNamespace: 4096,
        env: redirectedEnv,
      } as OpenBlobStoreOptions & { env: NodeJS.ProcessEnv });
      await store.register("viewer", new Uint8Array([1]), { kind: "viewer" });

      await closeOpenClawStateDatabaseAsync();
      resetPluginBlobStoreForTests();
      const { db } = openOpenClawStateDatabase({ env: state.env });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM plugin_blob_entries
             WHERE plugin_id = ? AND namespace = ? AND entry_key = ?`,
          )
          .get("diffs", "runtime-env", "viewer"),
      ).toEqual({ count: 1 });
    });
  });

  it("rejects external plugins in this release", () => {
    const registry = createTestPluginRegistry();
    const record = createPluginRecord("external-plugin", "workspace");
    registry.registry.plugins.push(record);
    const api = registry.createApi(record, { config: {} });

    expect(() =>
      api.runtime.state.openKeyedStore({ namespace: "runtime", maxEntries: 10 }),
    ).toThrow("openKeyedStore is only available for trusted plugins");
    expect(() =>
      api.runtime.state.openSyncKeyedStore({ namespace: "runtime", maxEntries: 10 }),
    ).toThrow("openSyncKeyedStore is only available for trusted plugins");
    expect(() =>
      api.runtime.state.openBlobStore({
        namespace: "runtime",
        maxEntries: 10,
        maxBytesPerEntry: 1024,
        maxBytesPerNamespace: 4096,
      }),
    ).toThrow("openBlobStore is only available for trusted plugins");
  });

  it("names the denied capability, plugin, source, and origin for channel ingress queues", () => {
    const registry = createTestPluginRegistry();
    const record = createPluginRecord("slack", "config");
    registry.registry.plugins.push(record);
    const api = registry.createApi(record, { config: {} });

    expect(() => api.runtime.state.openChannelIngressQueue()).toThrow(
      /openChannelIngressQueue is only available for trusted plugins in this release\. Plugin "slack" loaded from "\/plugins\/slack\/index\.ts" with origin "config"/,
    );
  });

  it("rejects untrusted global plugins", () => {
    const registry = createTestPluginRegistry();
    const record = createPluginRecord("diffs", "global");
    registry.registry.plugins.push(record);
    const api = registry.createApi(record, { config: {} });

    expect(() =>
      api.runtime.state.openKeyedStore({ namespace: "runtime", maxEntries: 10 }),
    ).toThrow("openKeyedStore is only available for trusted plugins");
    expect(() =>
      api.runtime.state.openBlobStore({
        namespace: "runtime",
        maxEntries: 10,
        maxBytesPerEntry: 1024,
        maxBytesPerNamespace: 4096,
      }),
    ).toThrow("openBlobStore is only available for trusted plugins");
  });
});
