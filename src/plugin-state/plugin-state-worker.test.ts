import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { deserialize, serialize } from "node:v8";
import { threadId, Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { captureSessionEntryCurrentRead } from "../config/sessions/session-entry-current-runtime.js";
import type {
  SessionEntryCurrentCheck,
  SessionEntryCurrentFacts,
} from "../config/sessions/session-entry-current.types.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { withEngineStoreAdmission } from "../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../infra/database-engine/mixed-agent.conformance.test-support.js";
import { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { PostgresSyncConnection } from "../infra/postgres-sync/connection.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { SQLITE_WORKER_MAX_RESULT_BYTES } from "../infra/sqlite-worker-contract.js";
import { holdForeignWriter } from "../infra/sqlite-worker-shared-state-admission.test-support.js";
import {
  appendMemoryHostEvent,
  readMemoryHostEventRecords,
} from "../plugin-sdk/memory-host-events.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { createOwnedTestInstance } from "../plugins/plugin-instance.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWriter from "../state/openclaw-state-worker-store.js";
import { VERSION } from "../version.js";
import {
  keyedStores,
  keyedStore as openStore,
  observePluginStateReads,
  syncKeyedStore,
  stateTest,
} from "./plugin-state-fixtures.test-support.js";
import type { FixtureOperations } from "./plugin-state-operation.test-support.js";
import {
  createPluginStateKeyedStore,
  createPluginStateKeyedStoreV2,
  createPluginStateSyncKeyedStore,
  pluginStateEntriesInKeyRange,
  registerPluginStateSequencedJournalEntry,
} from "./plugin-state-store.js";
import { PLUGIN_STATE_NAMESPACE_MAX_BYTES } from "./plugin-state-store.kernel.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";
import { executePluginStateCommand } from "./plugin-state.worker.js";

const it = stateTest("plugin-state-worker");

type SeedRow = Parameters<typeof seedPluginStateEntriesForTests>[0][number];
function seed(
  pluginId: string,
  namespace: string,
  rows: Omit<SeedRow, "pluginId" | "namespace">[],
) {
  seedPluginStateEntriesForTests(rows.map((row) => Object.assign({ pluginId, namespace }, row)));
}

function expectNoSql(sql: ReturnType<typeof observeHostDataSql>["calls"]) {
  sql.forEach((method) => expect(method).not.toHaveBeenCalled());
}

function loadNamespaceRows(
  store: ReturnType<typeof openOpenClawStateDatabase>,
  input: { pluginId: string; namespace: string; maxBytes: number },
) {
  const response = executePluginStateCommand(
    { type: "pluginState.loadNamespace", input },
    { path: store.path },
    () => store,
    true,
  );
  if (!response.ok) {
    throw new Error("Expected a successful namespace load");
  }
  return response.value;
}

const setValue = (value: string) => ({ operation: "update", action: "set", value }) as const;
const rowScope = "WHERE plugin_id = ? AND namespace = ?";
const updateRow = (
  plugin: string,
  namespace: string,
  key: string,
  column: string,
  value: string | bigint,
) =>
  openOpenClawStateDatabase()
    .db.prepare(`UPDATE plugin_state_entries SET ${column} = ? ${rowScope} AND entry_key = ?`)
    .run(value, plugin, namespace, key);
function authority(reason: string | Error) {
  let current = true;
  const error = typeof reason === "string" ? new Error(reason) : reason;
  return {
    assertCurrent: () => {
      if (!current) {
        throw error;
      }
    },
    revoke() {
      current = false;
    },
    restore() {
      current = true;
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

it.for([false, true])(
  "inspects durable plugin-state bytes with a warm resident view: %s",
  async (warm, { state }) => {
    const pluginId = "inspection-fixture";
    const namespace = "inspection-source";
    const store = openStore<string>(pluginId, namespace, { maxEntries: 1, env: state.env });
    await store.register("key", "persisted");
    if (warm) {
      expect(await store.lookup("key")).toBe("persisted");
    }
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    // Deliberate disk corruption without a host reader: inspection must use private durable bytes.
    const writer = new DatabaseSync(databasePath);
    try {
      writer
        .prepare(`UPDATE plugin_state_entries SET value_json = ? ${rowScope} AND entry_key = ?`)
        .run("invalid JSON", pluginId, namespace, "key");
    } finally {
      writer.close();
    }
    const artifacts = () =>
      ["", "-wal", "-shm"].map((suffix) => {
        const pathname = databasePath + suffix;
        return existsSync(pathname) ? readFileSync(pathname) : undefined;
      });
    const before = artifacts();
    await expect(withArtifactPreservingStateReads(() => store.lookup("key"))).rejects.toMatchObject(
      {
        code: "PLUGIN_STATE_CORRUPT",
        operation: "lookup",
        path: databasePath,
      },
    );
    expect(artifacts()).toEqual(before);
    await closeOpenClawStateDatabaseAsync();
    await store.register("key", "after-inspection");
    expect(await store.lookup("key")).toBe("after-inspection");
  },
);

it("checks cross-namespace leases in the write transaction", async ({ state }) => {
  const options = { namespace: "journal", maxEntries: 10, env: state.env };
  const owner = authority("owner closed");
  const entries = createPluginStateKeyedStoreV2<string>("lease-test", options, owner);
  const heads = createPluginStateKeyedStoreV2<string>(
    "lease-test",
    { ...options, namespace: "head" },
    owner,
  );
  await entries.register("previous", "unlinked");
  await heads.register("writer", "first-owner");
  const previous = await entries.observe("previous");
  const lease = await heads.observe("writer");
  const link = (comparison: string) =>
    entries.compareAndApply("previous", previous.comparison, setValue("linked"), {
      conditions: [{ namespace: "head", key: "writer", comparison }],
    });

  // The released synchronous writer can replace a lease after async preparation.
  const legacy = syncKeyedStore<string>("lease-test", "head", { ...options });
  legacy.register("writer", "replacement-owner");
  expect(await link(lease.comparison)).toEqual({ status: "conflict", current: previous });
  expect(await entries.lookup("previous")).toBe("unlinked");

  const replacement = await heads.observe("writer");
  expect(await link(replacement.comparison)).toEqual({ status: "applied" });
  owner.revoke();
  await expect(entries.delete("previous")).rejects.toThrow("owner closed");
  expect(legacy.lookup("writer")).toBe("replacement-owner");
});

it.for(["single", "compound"] as const)(
  "checks %s session claims through mutation",
  async (mode, { state }) => {
    const compound = mode === "compound";
    const field = compound ? "previousSessionId" : "lifecycleRevision";
    const targets = (compound ? ["lease", "mutation"] : ["claim"]).map((key) => ({
      agentId: "main",
      sessionKey: `agent:main:${key}`,
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main", env: state.env }),
      env: state.env,
    }));
    const facts: Array<SessionEntryCurrentFacts | undefined> = [];
    const checks: SessionEntryCurrentCheck[] = [];
    let assertCurrent = () => {};
    const entry = (index: number, lineage: string, updatedAt = 1) => ({
      sessionId: compound ? targets[index]!.sessionKey : "claim-session",
      [field]: lineage,
      updatedAt,
    });
    for (const [index, target] of targets.entries()) {
      await upsertSessionEntryCore(target, entry(index, "original"));
      const read = await withSessionEntryReadOnlyInWorker(
        target,
        () => {},
        async (result, owner) => {
          if (!result.ok) {
            throw result.error;
          }
          return captureSessionEntryCurrentRead(target, owner);
        },
      );
      if (!read.source) {
        throw new Error("Expected a file-backed session");
      }
      if (!compound) {
        assertCurrent = read.assertSourceCurrent;
      }
      checks.push({
        source: read.source,
        assertCurrent(current) {
          if (compound) {
            read.assertSourceCurrent();
          }
          facts.push(current);
          if (current?.[field] !== "original") {
            throw new Error("Session no longer owns this claim");
          }
        },
      });
    }
    const store = openStore<string>("device-pair", compound ? "compound-claim" : "session-claim", {
      env: state.env,
    });
    await store.register("tab", "open");
    const guarded = store.withCurrent({
      assertCurrent,
      sessionEntryCurrent: compound
        ? {
            sources: checks.map((check) => check.source),
            assertCurrent: (entries: readonly (SessionEntryCurrentFacts | undefined)[]) => {
              checks.forEach((check, index) => check.assertCurrent(entries[index]));
            },
          }
        : checks[0]!,
    });
    const first = await store.observe("tab");
    if (compound) {
      await expect(
        guarded.compareAndApply("tab", first.comparison, setValue("claimed")),
      ).resolves.toEqual({ status: "applied" });
    }
    const index = targets.length - 1;
    await upsertSessionEntryCore(targets[index]!, entry(index, "successor", compound ? 2 : 1));
    const comparison = compound ? (await store.observe("tab")).comparison : first.comparison;
    await expect(
      guarded.compareAndApply("tab", comparison, setValue(compound ? "forbidden" : "claimed")),
    ).rejects.toBeInstanceOf(PluginStateStoreError);
    expect(facts).toContainEqual(expect.objectContaining({ [field]: "successor" }));
    expect(await store.lookup("tab")).toBe(compound ? "claimed" : "open");
    if (!compound) {
      expect(await store.delete("tab")).toBe(true);
    }
  },
);

it.for(["register", "delete", "delete-aborted"] as const)(
  "revalidates %s authority after worker admission",
  async (operation, { state }) => {
    const store = openStore<string>("device-pair", "owner-admission", { env: state.env });
    await store.register("subscription", "original");
    const canceled = new AbortController();
    const owner = authority("command owner revoked");
    const pending =
      operation === "register"
        ? store.register("subscription", "replacement", owner)
        : store.delete("subscription", {
            assertCurrent: owner.assertCurrent,
            signal: operation === "delete-aborted" ? canceled.signal : undefined,
          });
    if (operation === "delete-aborted") {
      canceled.abort(new Error("callback task deadline expired"));
    } else {
      owner.revoke();
    }
    await expect(pending).rejects.toThrow("plugin state");
    expect(await store.lookup("subscription")).toBe("original");
  },
);

it("opens cold state and cleans expiry off-thread on reopen", async ({ state }) => {
  const databasePath = resolveOpenClawStateSqlitePath(state.env);
  const options = { namespace: "expiry", maxEntries: 10, env: state.env };
  const store = createPluginStateKeyedStore("fixture-plugin", options);
  const observation = observeHostDataSql();
  expect(existsSync(databasePath)).toBe(false);
  await store.register("permanent", true);
  expect(existsSync(databasePath)).toBe(true);
  expectNoSql(observation.calls);

  const now = Date.now();
  seed("fixture-plugin", "expiry", [
    { key: "expired", value: { expired: true }, expiresAt: now - 1 },
    { key: "live", value: { live: true }, expiresAt: now + 86_400_000 },
  ]);
  await closeOpenClawStateDatabaseAsync();
  for (const method of observation.calls) {
    method.mockClear();
  }
  await store.register("permanent", true);
  expect(await store.lookup("expired")).toBeUndefined();
  expect(await store.lookup("live")).toEqual({ live: true });
  expectNoSql(observation.calls);
  observation.restore();
  const persisted = createPluginStateSyncKeyedStore("fixture-plugin", options);
  expect(persisted.lookup("expired")).toBeUndefined();
  expect(persisted.lookup("live")).toEqual({ live: true });
});

it.for(["revoked", "closing"])(
  "settles cold plugin observation while %s",
  async (mode, { state }) => {
    const host = new LegacyPluginSdkResourceHost();
    const scheduler = new GatewayScheduler();
    host.bindScheduler(scheduler);
    const instance = createOwnedTestInstance("memory-core");
    const events: string[] = [];
    host.adopt(
      {},
      {
        release: async () => {
          events.push("retired");
        },
      },
    );
    let closing: Promise<void> | undefined;
    const revoked = new Error("plugin owner revoked after namespace loading");
    const owner = authority(revoked);
    const store = createPluginStateKeyedStore<string>(
      "memory-core",
      { namespace: "read-authority", retention: "retained", env: state.env },
      owner.assertCurrent,
    );
    await store.register("workspace", "owner");
    const loaded = createDeferredCore();
    const release = createDeferredCore();
    observePluginStateReads(async () => {
      loaded.resolve();
      await release.promise;
      events.push("read");
    });
    const pending = host
      .run(() => instance.run(() => store.observe("workspace")))
      .then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      );
    try {
      await Promise.race([
        loaded.promise,
        pending.then(() => {
          throw new Error("Plugin observation settled before namespace loading");
        }),
      ]);
      if (mode === "revoked") {
        owner.revoke();
      } else {
        scheduler.beginClose();
        closing = host.close();
        await expect(
          host.run(() => instance.run(() => store.register("late", "refused"))),
        ).rejects.toMatchObject({ code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" });
      }
      release.resolve();
      await expect(pending).resolves.toMatchObject(
        mode === "revoked"
          ? { ok: false, error: { code: "PLUGIN_STATE_READ_FAILED", cause: revoked } }
          : { ok: true, value: { value: "owner" } },
      );
      await closing;
      if (mode === "closing") {
        expect(events).toEqual(["read", "retired"]);
      }
    } finally {
      release.resolve();
      await pending;
      await host.close();
      await scheduler.stop();
      owner.restore();
    }
    expect(await store.observe("workspace")).toMatchObject({ value: "owner" });
  },
);

it("revalidates contended compareDelete and rolls back refused transactions", async ({ state }) => {
  const revoked = new Error("plugin owner revoked after dispatch");
  const owner = authority(revoked);
  const store = createPluginStateKeyedStore<string>(
    "memory-core",
    {
      namespace: "writer-contention",
      retention: "retained",
      env: state.env,
    },
    owner.assertCurrent,
  );
  const messages = vi.spyOn(Worker.prototype, "postMessage");
  await store.register("workspace", "owner");
  const worker = messages.mock.contexts[0];
  messages.mockRestore();
  if (!(worker instanceof Worker)) {
    throw new Error("Expected the shared-state worker");
  }
  const observation = await store.observe("workspace");
  const captured = captureOpenClawStateWorkerContext({ env: state.env });
  const foreign = holdForeignWriter(captured);
  const posted = createDeferredCore();
  const nativePost = worker.postMessage.bind(worker);
  const dispatch = vi.spyOn(worker, "postMessage").mockImplementation((message, transferList) => {
    const request = asOptionalRecord(message);
    const command =
      request?.type === "execute" && request.input instanceof Uint8Array
        ? asOptionalRecord(deserialize(request.input))?.type
        : undefined;
    nativePost(message, transferList);
    if (command === "pluginState.compareDelete") {
      posted.resolve();
    }
  });
  const execute = () =>
    store.compareAndApply("workspace", observation.comparison, {
      operation: "delete",
      action: "delete",
    });
  const pending = execute().then(
    (value) => ({ ok: true, value }) as const,
    (error: unknown) => ({ ok: false, error }) as const,
  );
  try {
    await Promise.race([
      posted.promise,
      pending.then(() => {
        throw new Error("Plugin operation settled before worker dispatch");
      }),
    ]);
    // The dispatched operation must revalidate authority after acquiring the native writer.
    owner.revoke();
    foreign.release();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: {
        code: "PLUGIN_STATE_WRITE_FAILED",
        cause: revoked,
      },
    });
  } finally {
    dispatch.mockRestore();
    foreign.close();
    await pending;
    owner.restore();
  }
  expect(await store.lookup("workspace")).toBe("owner");
  // Claim the actual writer lock before closing the worker to prove refusal rolled back.
  const nextOwner = holdForeignWriter(captured);
  nextOwner.close();
  await expect(execute()).resolves.toEqual({ status: "applied" });
  expect(await store.lookup("workspace")).toBeUndefined();
});

it("persists exact journal bytes without host SQL or creating an absent read source", async ({
  state,
}) => {
  const event = {
    type: "memory.recall.recorded" as const,
    timestamp: "2026-09-13T12:00:00.000Z",
    query: "ordinary journal event",
    resultCount: 0,
    results: [],
  };
  const { workspaceDir, env } = state;
  const read = () => readMemoryHostEventRecords({ workspaceDir, env });
  const observation = observeHostDataSql();
  try {
    expect(await read()).toEqual([]);
    expect(existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
    await appendMemoryHostEvent(workspaceDir, event, { env });
    expect(await read()).toEqual([event]);
    expectNoSql(observation.calls);
  } finally {
    observation.restore();
  }
  const { db } = openOpenClawStateDatabase({ env });
  const rowsIn = (namespace: string) =>
    db
      .prepare(
        "SELECT entry_key, value_json FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ?",
      )
      .all("memory-core", namespace);
  const rows = rowsIn("memory-host.events");
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  const { recordedAt } = JSON.parse(String(row.value_json)) as { recordedAt: number };
  expect(row.entry_key).toMatch(/^[a-f0-9]{24}:event:1:0000000000000001$/);
  expect(row.value_json).toBe(JSON.stringify({ kind: "event", event, recordedAt, sequence: 1 }));
  expect(rowsIn("memory-host.event-cursors")).toMatchObject([
    {
      value_json: '{"kind":"cursor","lastSequence":1}',
    },
  ]);
});

it("captures journal data and range before admission", async ({ state }) => {
  const journalValue = { kind: "event", detail: { value: "captured" } };
  const journalKeyRange = { keyStartInclusive: "event:", keyEndExclusive: "event;" };
  const scope = { pluginId: "memory-core", env: state.env };
  const journalOptions = { namespace: "memory-host.events", maxEntries: 10_000, ...scope };
  const cursorOptions = { namespace: "memory-host.event-cursors", maxEntries: 1_000, ...scope };
  seed(scope.pluginId, cursorOptions.namespace, [
    { key: "workspace:cursor", value: { kind: "cursor", lastSequence: 0 } },
  ]);
  const cursor = createPluginStateKeyedStore(scope.pluginId, cursorOptions);
  const journal = createPluginStateKeyedStore(scope.pluginId, journalOptions);
  expect(await cursor.lookup("workspace:cursor")).toEqual({ kind: "cursor", lastSequence: 0 });
  expect(await journal.entries()).toEqual([]);
  const reads = observePluginStateReads();
  const pending = registerPluginStateSequencedJournalEntry({
    ...scope,
    cursorOptions,
    cursorKey: "workspace:cursor",
    journalOptions,
    journalKeyPrefix: "event:1:",
    journalKeyRange,
    journalValue,
  });
  journalValue.detail.value = "changed";
  journalKeyRange.keyStartInclusive = "changed:";
  journalKeyRange.keyEndExclusive = "changed;";
  await expect(pending).resolves.toBe(1);
  await expect(
    pluginStateEntriesInKeyRange({
      ...journalOptions,
      keyStartInclusive: "event:",
      keyEndExclusive: "event;",
      limit: 1,
    }),
  ).resolves.toMatchObject([
    {
      key: "event:1:0000000000000001",
      value: { kind: "event", detail: { value: "captured" }, sequence: 1 },
    },
  ]);
  expect(await cursor.lookup("workspace:cursor")).toEqual({ kind: "cursor", lastSequence: 1 });
  expect(reads).not.toHaveBeenCalled();
});

it("preserves listing order and expiry while refreshing TTLs", async ({ state: _state }) => {
  const namespace = "ttl-order";
  const now = Date.now();
  seed("slack", namespace, [
    { key: "z", value: 1, createdAt: now - 2_000, expiresAt: now + 86_400_000 },
    { key: "a", value: 2, createdAt: now - 2_000 },
    { key: "expired", value: 3, createdAt: now - 3_000, expiresAt: now - 1 },
  ]);
  const store = openStore<number>("slack", namespace, { defaultTtlMs: 60_000 });
  expect((await store.entries()).map(({ key }) => key)).toEqual(["a", "z"]);
  expect(await store.lookup("expired")).toBeUndefined();
  expect(await store.consume("expired")).toBeUndefined();
  expect(await store.delete("expired")).toBe(true);
  for (const [value, ttlMs] of [
    [4, undefined],
    [5, 120_000],
  ] as const) {
    const before = Date.now();
    await store.register("fresh", value, ttlMs === undefined ? undefined : { ttlMs });
    const after = Date.now();
    const entries = await store.entries();
    const fresh = entries.find(({ key }) => key === "fresh");
    expect(entries.map(({ key }) => key)).toEqual(["a", "z", "fresh"]);
    expect(fresh?.value).toBe(value);
    expect(fresh?.createdAt).toBeGreaterThanOrEqual(before);
    expect(fresh?.createdAt).toBeLessThanOrEqual(after);
    expect(fresh?.expiresAt).toBe((fresh?.createdAt ?? 0) + (ttlMs ?? 60_000));
  }
});

it.for(["created_at", "expires_at"] as const)(
  "prioritizes native %s errors over earlier corrupt JSON",
  async (column, { state: _state }) => {
    const pluginId = "memory-core";
    const namespace = "listing-errors";
    seed(
      pluginId,
      namespace,
      ["healthy", "corrupt", "unsafe"].map((key, i) => ({ key, value: 1, createdAt: 1000 + i })),
    );
    const { path: databasePath } = openOpenClawStateDatabase();
    updateRow(pluginId, namespace, "corrupt", "value_json", "invalid JSON");
    const { sync, store } = keyedStores(pluginId, { namespace, maxEntries: 3 });
    const corrupt = {
      code: "PLUGIN_STATE_CORRUPT",
      operation: "entries",
      path: databasePath,
    };
    expect(() => sync.entries()).toThrowError(expect.objectContaining(corrupt));
    await expect(store.entries()).rejects.toMatchObject(corrupt);

    // Raw fault injection starts a new owner lifecycle, outside the publication contract.
    await closeOpenClawStateDatabaseAsync();
    updateRow(pluginId, namespace, "unsafe", column, 9223372036854775807n);
    const { db } = openOpenClawStateDatabase();
    const snapshot = db.prepare(
      `SELECT * FROM plugin_state_entries ${rowScope} ORDER BY entry_key`,
    );
    snapshot.setReadBigInts(true);
    const before = snapshot.all(pluginId, namespace);
    const nativeError = {
      code: "PLUGIN_STATE_READ_FAILED",
      operation: "entries",
      path: databasePath,
      cause: expect.objectContaining({ name: "RangeError", code: "ERR_OUT_OF_RANGE" }),
    };
    expect(() => sync.entries()).toThrowError(expect.objectContaining(nativeError));
    expect(snapshot.all(pluginId, namespace)).toEqual(before);
    await expect(store.entries()).rejects.toMatchObject(nativeError);
    expect(snapshot.all(pluginId, namespace)).toEqual(before);
  },
);

it("returns complete entries and bulk values beyond a broker frame", async ({ state: _state }) => {
  const namespace = "large-reads";
  const payloadBytes = 900_000;
  const count = Math.ceil(SQLITE_WORKER_MAX_RESULT_BYTES / payloadBytes) + 1;
  const values = Array.from(
    { length: count },
    (_, index) => `${index}:${"x".repeat(payloadBytes)}`,
  );
  const keys = values.map((_, index) => `key-${index}`);
  seed(
    "slack",
    namespace,
    values.map((value, index) => ({
      key: keys[index]!,
      value,
      createdAt: 1000 + index,
    })),
  );
  await closeOpenClawStateDatabaseAsync();
  const store = openStore<string>("slack", namespace, { maxEntries: count });
  const observation = observeHostDataSql();
  const entries = await store.entries();
  expect(serialize(entries).byteLength).toBeGreaterThan(SQLITE_WORKER_MAX_RESULT_BYTES);
  expect(entries.map((entry) => entry.value)).toEqual(values);
  const request = [...keys.toReversed(), keys[0]!];
  const results = await store.lookupMany(request);
  expect(serialize(results).byteLength).toBeGreaterThan(SQLITE_WORKER_MAX_RESULT_BYTES);
  expect(results).toEqual(
    [...values.toReversed(), values[0]].map((value) => ({ ok: true, value })),
  );
  expectNoSql(observation.calls);
});

it("preserves ordered claims, scalar equality, expiry, and corrupt JSON errors", async ({
  state: _state,
}) => {
  const options = {
    namespace: "conditional",
    maxEntries: 1,
    overflowPolicy: "reject-new" as const,
  };
  const { sync: legacy, store } = keyedStores<unknown>("slack", options);
  const pendingWrite = store.registerIfAbsent("entry", 1);
  await expect(store.lookup("entry")).resolves.toBe(1);
  await expect(pendingWrite).resolves.toBe(true);
  const original = await store.entries();
  const claims = vi.spyOn(stateWriter, "runOpenClawStateWorkerOperation");
  expect(await store.registerIfAbsent("entry", 2, { ttlMs: 60_000 })).toBe(false);
  expect(await store.entries()).toEqual(original);
  expect(claims.mock.calls.length).toBe(0);
  await expect(
    store.registerIfAbsent("entry", 2, { ttlMs: Number.MAX_SAFE_INTEGER }),
  ).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT" });
  seed("slack", options.namespace, [{ key: "expired", value: 0, expiresAt: 1 }]);
  expect(await store.registerIfAbsent("entry", 2)).toBe(false);
  const db = openOpenClawStateDatabase().db;
  expect(db.prepare("SELECT 1 FROM plugin_state_entries WHERE expires_at = 1").all()).toEqual([]);
  claims.mockRestore();
  const deletion = store.delete("entry");
  expect(await store.registerIfAbsent("entry", 1)).toBe(true);
  await deletion;
  expect(await store.deleteIfEqual("entry", "1")).toBe(false);
  seed("slack", options.namespace, [{ key: "entry", value: 1, expiresAt: Date.now() - 1 }]);
  expect(await store.deleteIfEqual("entry", 1)).toBe(false);
  expect(await store.registerIfAbsent("entry", null)).toBe(true);
  expect(await store.deleteIfEqual("entry", null)).toBe(true);

  legacy.register("entry", false);
  const { path: databasePath } = openOpenClawStateDatabase();
  updateRow("slack", options.namespace, "entry", "value_json", "invalid JSON");
  const corrupt = await store.deleteIfEqual("entry", false).catch((error: unknown) => error);
  expect(corrupt).toBeInstanceOf(PluginStateStoreError);
  expect(corrupt).toMatchObject({
    code: "PLUGIN_STATE_CORRUPT",
    operation: "delete",
    path: databasePath,
    cause: expect.any(SyntaxError),
    owner: { pid: process.pid, threadId: expect.any(Number), version: VERSION },
  });
  expect(corrupt).not.toHaveProperty("owner.threadId", threadId);
});

it("bounds cold namespace payloads without dropping physically present expired rows", ({
  state: _state,
}) => {
  const scope = { pluginId: "namespace-bounds", namespace: "bytes" };
  seed(scope.pluginId, scope.namespace, [
    { key: "a", value: "live", createdAt: 1 },
    { key: "b", value: "expired", createdAt: 2, expiresAt: 1 },
  ]);
  const database = openOpenClawStateDatabase();
  expect(
    loadNamespaceRows(database, { ...scope, maxBytes: 290 })?.map((row) => row.entry_key),
  ).toEqual(["a", "b"]);
  expect(loadNamespaceRows(database, { ...scope, maxBytes: 289 })).toBeUndefined();
  const rowsScope = { ...scope, namespace: "rows" };
  seed(
    rowsScope.pluginId,
    rowsScope.namespace,
    Array.from({ length: 10_000 }, (_, i) => ({ key: String(i), value: 1 })),
  );
  expect(
    loadNamespaceRows(database, {
      ...rowsScope,
      maxBytes: PLUGIN_STATE_NAMESPACE_MAX_BYTES,
    }),
  ).toHaveLength(10_000);
  seed(rowsScope.pluginId, rowsScope.namespace, [{ key: "overflow", value: 1 }]);
  expect(
    loadNamespaceRows(database, {
      ...rowsScope,
      maxBytes: PLUGIN_STATE_NAMESPACE_MAX_BYTES,
    }),
  ).toBeUndefined();
});

describe.skipIf(!mixedAgentConnection)("PostgreSQL complete plugin-state views", () => {
  useMixedAgentPair("postgres", "postgres");

  it("bounds cold buffered loads and serves committed writes and operation snapshots without rereads", async () => {
    const scope = { pluginId: "pg-namespace", namespace: "bounded" };
    withEngineStoreAdmission(() =>
      seed(scope.pluginId, scope.namespace, [
        { key: "a", value: "live", createdAt: 1 },
        { key: "b", value: "expired", createdAt: 2, expiresAt: 1 },
      ]),
    );
    const database = withEngineStoreAdmission(() => openOpenClawStateDatabase());
    if (!isPostgresSqlConnection(database.db)) {
      throw new Error("Expected the configured PostgreSQL engine");
    }
    const queries = vi.spyOn(PostgresSyncConnection.prototype, "query");
    const rows = withEngineStoreAdmission(() =>
      loadNamespaceRows(database, { ...scope, maxBytes: 290 }),
    );
    expect(rows?.map((row) => row.entry_key).toSorted()).toEqual(["a", "b"]);
    expect(queries.mock.calls.map(([sql]) => sql)).toContainEqual(
      expect.stringContaining("REPEATABLE READ READ ONLY"),
    );
    expect(
      queries.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes("plugin_state_entries")),
    ).toEqual([
      expect.stringContaining("octet_length"),
      expect.stringContaining('select "entry_key", "value_json"'),
    ]);
    queries.mockClear();
    expect(
      withEngineStoreAdmission(() => loadNamespaceRows(database, { ...scope, maxBytes: 289 })),
    ).toBeUndefined();
    expect(
      queries.mock.calls.map(([sql]) => sql).filter((sql) => sql.includes("plugin_state_entries")),
    ).toEqual([expect.stringContaining("octet_length")]);
    const modulePath = fileURLToPath(
      new URL("./plugin-state-operation.test-support.ts", import.meta.url),
    );
    const module = {
      modulePath,
      boundaryRoot: path.dirname(modulePath),
      origin: "bundled" as const,
      pluginId: scope.pluginId,
    };
    const store = createPluginStateKeyedStore<string>(
      scope.pluginId,
      { namespace: scope.namespace, maxEntries: 10 },
      undefined,
      { resolve: () => module },
    );
    const sync = syncKeyedStore<string>(scope.pluginId, scope.namespace);
    expect(await store.lookup("a")).toBe("live");
    const reads = observePluginStateReads();
    withEngineStoreAdmission(() => sync.register("a", "sync"));
    expect(await store.lookup("a")).toBe("sync");
    await store.register("a", "worker");
    expect(await store.lookup("a")).toBe("worker");
    const operation = store.createOperation<FixtureOperations>([store], {
      moduleName: "plugin-state-operation.test-support.ts",
      exportName: "execute",
    });
    const result = await operation.execute(
      { type: "read", input: { store: 0, key: "a" } },
      { writeStores: [] },
    );
    expect(result.value).toMatchObject({ value: "worker" });
    expect(result.value.threadId).toBeGreaterThan(0);
    await expect(
      operation.execute(
        { type: "read", input: { store: 0, key: "nul\0key" } },
        { writeStores: [] },
      ),
    ).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT" });
    expect(reads).not.toHaveBeenCalled();

    const oversized = openStore<string>(scope.pluginId, "oversized");
    const largeValue = "x".repeat(840_000);
    withEngineStoreAdmission(() =>
      seed(
        scope.pluginId,
        "oversized",
        Array.from({ length: 5 }, (_, index) => ({ key: String(index), value: largeValue })),
      ),
    );
    expect(await oversized.count()).toBe(5);
    expect(reads).toHaveBeenCalledTimes(2);
    reads.mockClear();
    expect(await oversized.count()).toBe(5);
    expect(reads).toHaveBeenCalledOnce();
    await oversized.delete("4");
    reads.mockClear();
    expect(await oversized.count()).toBe(4);
    expect(reads).toHaveBeenCalledOnce();
    reads.mockClear();
    expect(await oversized.count()).toBe(4);
    expect(reads).not.toHaveBeenCalled();
  });
});
