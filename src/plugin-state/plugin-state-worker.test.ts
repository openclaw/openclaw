import { existsSync } from "node:fs";
import { deserialize, serialize } from "node:v8";
import { threadId, Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { captureSessionEntryCurrentRead } from "../config/sessions/session-entry-current-runtime.js";
import type {
  SessionEntryCurrentCheck,
  SessionEntryCurrentFacts,
} from "../config/sessions/session-entry-current.types.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { SQLITE_WORKER_MAX_RESULT_BYTES } from "../infra/sqlite-worker-contract.js";
import { holdForeignWriter } from "../infra/sqlite-worker-shared-state-admission.test-support.js";
import {
  appendMemoryHostEvent,
  readMemoryHostEventRecords,
} from "../plugin-sdk/memory-host-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { VERSION } from "../version.js";
import {
  keyedStores,
  keyedStore as openStore,
  syncKeyedStore,
  stateTest,
} from "./plugin-state-fixtures.test-support.js";
import {
  createPluginStateKeyedStore,
  createPluginStateKeyedStoreV2,
  createPluginStateSyncKeyedStore,
  pluginStateEntriesInKeyRange,
  registerPluginStateSequencedJournalEntry,
} from "./plugin-state-store.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";

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

it("keeps reads behind earlier writes", async ({ state }) => {
  const scope = { pluginId: "reader-fixture", namespace: "reconnect", env: state.env };
  const store = createPluginStateKeyedStoreV2<string>(
    scope.pluginId,
    { ...scope, maxEntries: 10 },
    { assertCurrent() {} },
  );
  const pendingWrite = store.register("b", "second");
  await expect(store.lookup("b")).resolves.toBe("second");
  await pendingWrite;
});

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

it.for(["observe", "compareDelete"] as const)(
  "revalidates contended %s and rolls back refused transactions",
  async (operation, { state }) => {
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
      if (command === "pluginState." + operation) {
        posted.resolve();
      }
    });
    const execute = () =>
      operation === "observe"
        ? store.observe("uncached-workspace")
        : store.compareAndApply("workspace", observation.comparison, {
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
          code: operation === "observe" ? "PLUGIN_STATE_READ_FAILED" : "PLUGIN_STATE_WRITE_FAILED",
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
    if (operation === "observe") {
      await expect(execute()).resolves.toMatchObject({ value: undefined });
    } else {
      await expect(execute()).resolves.toEqual({ status: "applied" });
    }
    expect(await store.lookup("workspace")).toBe(operation === "observe" ? "owner" : undefined);
  },
);

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
  const pending = registerPluginStateSequencedJournalEntry({
    ...scope,
    cursorOptions: { namespace: "memory-host.event-cursors", maxEntries: 1_000, ...scope },
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
    const { db, path } = openOpenClawStateDatabase();
    updateRow(pluginId, namespace, "corrupt", "value_json", "invalid JSON");
    const { sync, store } = keyedStores(pluginId, { namespace, maxEntries: 3 });
    const corrupt = { code: "PLUGIN_STATE_CORRUPT", operation: "entries", path };
    expect(() => sync.entries()).toThrowError(expect.objectContaining(corrupt));
    await expect(store.entries()).rejects.toMatchObject(corrupt);

    updateRow(pluginId, namespace, "unsafe", column, 9223372036854775807n);
    const snapshot = db.prepare(
      `SELECT * FROM plugin_state_entries ${rowScope} ORDER BY entry_key`,
    );
    snapshot.setReadBigInts(true);
    const before = snapshot.all(pluginId, namespace);
    const nativeError = {
      code: "PLUGIN_STATE_READ_FAILED",
      operation: "entries",
      path,
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

it("preserves scalar equality, expiry, and corrupt JSON errors", async ({ state: _state }) => {
  const options = {
    namespace: "conditional",
    maxEntries: 1,
    overflowPolicy: "reject-new" as const,
  };
  const { sync: legacy, store } = keyedStores<unknown>("slack", options);
  expect(await store.registerIfAbsent("entry", 1)).toBe(true);
  expect(await store.deleteIfEqual("entry", "1")).toBe(false);
  seed("slack", options.namespace, [{ key: "entry", value: 1, expiresAt: Date.now() - 1 }]);
  expect(await store.deleteIfEqual("entry", 1)).toBe(false);
  expect(await store.registerIfAbsent("entry", null)).toBe(true);
  expect(await store.deleteIfEqual("entry", null)).toBe(true);

  legacy.register("entry", false);
  const { path } = openOpenClawStateDatabase();
  updateRow("slack", options.namespace, "entry", "value_json", "invalid JSON");
  const corrupt = await store.deleteIfEqual("entry", false).catch((error: unknown) => error);
  expect(corrupt).toBeInstanceOf(PluginStateStoreError);
  expect(corrupt).toMatchObject({
    code: "PLUGIN_STATE_CORRUPT",
    operation: "delete",
    path,
    cause: expect.any(SyntaxError),
    owner: { pid: process.pid, threadId: expect.any(Number), version: VERSION },
  });
  expect(corrupt).not.toHaveProperty("owner.threadId", threadId);
});
