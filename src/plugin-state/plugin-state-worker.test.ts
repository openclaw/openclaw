import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { deserialize, serialize } from "node:v8";
import { threadId, Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { captureSessionEntryCurrentRead } from "../config/sessions/session-entry-current-runtime.js";
import type {
  SessionEntryCurrentCheck,
  SessionEntryCurrentFacts,
} from "../config/sessions/session-entry-current.types.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
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
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { VERSION } from "../version.js";
import { stateTest } from "./plugin-state-fixtures.test-support.js";
import {
  createPluginStateKeyedStore,
  createPluginStateKeyedStoreV2,
  createPluginStateSyncKeyedStore,
  pluginStateEntriesInKeyRange,
  registerPluginStateSequencedJournalEntry,
  type OpenKeyedStoreOptions,
} from "./plugin-state-store.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";

const it = stateTest("plugin-state-worker");

function openStore<T>(
  pluginId: string,
  namespace: string,
  options: Partial<OpenKeyedStoreOptions> = {},
) {
  return createPluginStateKeyedStore<T>(pluginId, { namespace, maxEntries: 10, ...options });
}

function sessionTarget(env: NodeJS.ProcessEnv, key: string) {
  return {
    agentId: "main",
    sessionKey: `agent:main:${key}`,
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main", env }),
    env,
  };
}

async function captureCurrent(target: ReturnType<typeof sessionTarget>) {
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
  return { source: read.source, assertSourceCurrent: read.assertSourceCurrent };
}

function expectNoSql(sql: ReturnType<typeof observeHostDataSql>["calls"]) {
  sql.forEach((method) => expect(method).not.toHaveBeenCalled());
}

const setValue = (value: string) => ({ operation: "update", action: "set", value }) as const;

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

describe("worker plugin state", () => {
  it("keeps pure reads off the writer queue and observes earlier namespace writes", async ({
    state,
  }) => {
    const pluginId = "reader-fixture";
    const namespace = "reconnect";
    const store = createPluginStateKeyedStoreV2<string>(
      pluginId,
      {
        namespace,
        maxEntries: 10,
        env: state.env,
      },
      { assertCurrent() {} },
    );
    await store.register("a", "first");
    await waitForDiagnosticEventsDrained();
    const queued: string[] = [];
    const unsubscribe = onInternalDiagnosticEvent(
      (event) => {
        if (
          event.type === "worker.request" &&
          event.requestClass === "plugin_state" &&
          event.phase === "queued"
        ) {
          queued.push(event.kind);
        }
      },
      { include: ["worker.request"] },
    );
    try {
      expect(await store.lookup("missing")).toBeUndefined();
      expect(await store.lookupMany(["a", "missing"])).toEqual([
        { ok: true, value: "first" },
        { ok: true, value: undefined },
      ]);
      expect((await store.entries()).map(({ key, value }) => [key, value])).toEqual([
        ["a", "first"],
      ]);
      expect(await store.count()).toBe(1);
      expect(
        (
          await pluginStateEntriesInKeyRange({
            pluginId,
            namespace,
            env: state.env,
            keyStartInclusive: "a",
            keyEndExclusive: "b",
            limit: 10,
          })
        ).map(({ key, value }) => [key, value]),
      ).toEqual([["a", "first"]]);
      await waitForDiagnosticEventsDrained();
      expect(queued).toHaveLength(5);
      expect(queued).not.toContain("sqlite_writer");

      const pendingWrite = store.register("b", "second");
      const followingRead = store.lookup("b");
      await expect(followingRead).resolves.toBe("second");
      await pendingWrite;
    } finally {
      unsubscribe();
    }
  });

  it("compares cross-namespace lease conditions in the same worker transaction as the write", async ({
    state,
  }) => {
    const options = { namespace: "journal", maxEntries: 10, env: state.env };
    let active = true;
    const authority = {
      assertCurrent: () => {
        if (!active) {
          throw new Error("owner closed");
        }
      },
    };
    const entries = createPluginStateKeyedStoreV2<string>("lease-test", options, authority);
    const heads = createPluginStateKeyedStoreV2<string>(
      "lease-test",
      { ...options, namespace: "head" },
      authority,
    );
    await entries.register("previous", "unlinked");
    await heads.register("writer", "first-owner");
    const previous = await entries.observe("previous");
    const lease = await heads.observe("writer");
    const conditions = [{ namespace: "head", key: "writer", comparison: lease.comparison }];

    // The released synchronous writer can replace a lease after async preparation.
    const legacy = createPluginStateSyncKeyedStore<string>("lease-test", {
      ...options,
      namespace: "head",
    });
    legacy.register("writer", "replacement-owner");
    expect(
      await entries.compareAndApply(
        "previous",
        previous.comparison,
        { operation: "update", action: "set", value: "linked" },
        { conditions },
      ),
    ).toEqual({ status: "conflict", current: previous });
    expect(await entries.lookup("previous")).toBe("unlinked");

    const replacement = await heads.observe("writer");
    expect(
      await entries.compareAndApply(
        "previous",
        previous.comparison,
        { operation: "update", action: "set", value: "linked" },
        {
          conditions: [{ namespace: "head", key: "writer", comparison: replacement.comparison }],
        },
      ),
    ).toEqual({ status: "applied" });
    active = false;
    await expect(entries.delete("previous")).rejects.toThrow("owner closed");
    expect(legacy.lookup("writer")).toBe("replacement-owner");
  });

  it("keeps a session-bound comparison from claiming state after its session changes", async ({
    state,
  }) => {
    const target = sessionTarget(state.env, "claim");
    const entry = { sessionId: "claim-session", updatedAt: 1, lifecycleRevision: "original" };
    await upsertSessionEntryCore(target, entry);
    const read = await captureCurrent(target);
    const store = openStore<string>("device-pair", "session-claim", { env: state.env });
    await store.register("tab", "open");
    const comparison = (await store.observe!("tab")).comparison;
    const facts: Array<SessionEntryCurrentFacts | undefined> = [];
    const guarded = store.withCurrent!({
      assertCurrent: read.assertSourceCurrent,
      sessionEntryCurrent: {
        source: read.source,
        assertCurrent(current: SessionEntryCurrentFacts | undefined) {
          facts.push(current);
          if (current?.lifecycleRevision !== "original") {
            throw new Error("Session no longer owns this claim");
          }
        },
      },
    });
    await upsertSessionEntryCore(target, { ...entry, lifecycleRevision: "successor" });
    await expect(
      guarded.compareAndApply("tab", comparison, setValue("claimed")),
    ).rejects.toBeInstanceOf(PluginStateStoreError);
    expect(facts).toContainEqual(expect.objectContaining({ lifecycleRevision: "successor" }));
    expect(await store.lookup("tab")).toBe("open");
    expect(await store.delete("tab")).toBe(true);
  });

  it("keeps every captured session current through a compound native claim", async ({ state }) => {
    const checks: SessionEntryCurrentCheck[] = [];
    const targets = ["lease", "mutation"].map((key) => sessionTarget(state.env, key));
    for (const target of targets) {
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionKey,
        previousSessionId: "original",
        updatedAt: 1,
      });
      const read = await captureCurrent(target);
      checks.push({
        source: read.source,
        assertCurrent: (current: SessionEntryCurrentFacts | undefined) => {
          read.assertSourceCurrent();
          if (current?.previousSessionId !== "original") {
            throw new Error("Session lineage changed");
          }
        },
      });
    }
    const store = openStore<string>("device-pair", "compound-claim", { env: state.env });
    await store.register("tab", "open");
    const guarded = store.withCurrent!({
      assertCurrent: () => {},
      sessionEntryCurrent: {
        sources: checks.map((check) => check.source),
        assertCurrent: (entries: readonly (SessionEntryCurrentFacts | undefined)[]) => {
          checks.forEach((check, index) => check.assertCurrent(entries[index]));
        },
      },
    });
    const first = await store.observe!("tab");
    await expect(
      guarded.compareAndApply("tab", first.comparison, setValue("claimed")),
    ).resolves.toEqual({ status: "applied" });
    await upsertSessionEntryCore(targets[1]!, {
      sessionId: targets[1]!.sessionKey,
      previousSessionId: "successor",
      updatedAt: 2,
    });
    const next = await store.observe!("tab");
    await expect(
      guarded.compareAndApply("tab", next.comparison, setValue("forbidden")),
    ).rejects.toBeInstanceOf(PluginStateStoreError);
    expect(await store.lookup("tab")).toBe("claimed");
  });

  it.for(["register", "delete", "delete-aborted"] as const)(
    "revalidates caller authority after asynchronous worker admission for %s",
    async (operation, { state }) => {
      const store = openStore<string>("device-pair", "owner-admission", { env: state.env });
      await store.register("subscription", "original");
      const canceled = new AbortController();
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("command owner revoked");
        }
      };
      const pending =
        operation === "register"
          ? store.register("subscription", "replacement", { assertCurrent })
          : store.delete("subscription", {
              assertCurrent,
              signal: operation === "delete-aborted" ? canceled.signal : undefined,
            });
      if (operation === "delete-aborted") {
        canceled.abort(new Error("callback task deadline expired"));
      } else {
        current = false;
      }
      await expect(pending).rejects.toThrow("plugin state");
      expect(await store.lookup("subscription")).toBe("original");
    },
  );

  it("opens cold state and cleans expired rows on reopened writes without host data SQL", async ({
    state,
  }) => {
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    const store = openStore("fixture-plugin", "expiry", { env: state.env });
    const observation = observeHostDataSql();
    try {
      expect(existsSync(databasePath)).toBe(false);
      await store.register("permanent", true);
      expect(existsSync(databasePath)).toBe(true);
      expectNoSql(observation.calls);

      const now = Date.now();
      seedPluginStateEntriesForTests(
        [
          { key: "expired", value: { expired: true }, expiresAt: now - 1 },
          { key: "live", value: { live: true }, expiresAt: now + 86_400_000 },
        ].map((entry) => Object.assign({ pluginId: "fixture-plugin", namespace: "expiry" }, entry)),
      );
      await closeOpenClawStateDatabaseAsync();
      for (const method of observation.calls) {
        method.mockClear();
      }
      await store.register("permanent", true);
      expect(await store.lookup("expired")).toBeUndefined();
      expect(await store.lookup("live")).toEqual({ live: true });
      expectNoSql(observation.calls);
    } finally {
      observation.restore();
    }
    const persisted = createPluginStateSyncKeyedStore("fixture-plugin", {
      namespace: "expiry",
      maxEntries: 10,
      env: state.env,
    });
    expect(persisted.lookup("expired")).toBeUndefined();
    expect(persisted.lookup("live")).toEqual({ live: true });
  });

  it.for(["observe", "compareDelete"] as const)(
    "revalidates %s authority after native writer contention and releases refused transactions",
    async (operation, { state }) => {
      let current = true;
      const revoked = new Error("plugin owner revoked after dispatch");
      const store = createPluginStateKeyedStore<string>(
        "memory-core",
        {
          namespace: "writer-contention",
          retention: "retained",
          env: state.env,
        },
        () => {
          if (!current) {
            throw revoked;
          }
        },
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
      const dispatch = vi
        .spyOn(worker, "postMessage")
        .mockImplementation((message, transferList) => {
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
        current = false;
        foreign.release();
        await expect(pending).resolves.toMatchObject({
          ok: false,
          error: {
            code:
              operation === "observe" ? "PLUGIN_STATE_READ_FAILED" : "PLUGIN_STATE_WRITE_FAILED",
            cause: revoked,
          },
        });
      } finally {
        dispatch.mockRestore();
        foreign.close();
        await pending;
        current = true;
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

  it("appends and reads the memory journal off-thread with unchanged persisted bytes", async ({
    state,
  }) => {
    const workspaceDir = state.workspaceDir;
    const event = {
      type: "memory.recall.recorded" as const,
      timestamp: "2026-09-13T12:00:00.000Z",
      query: "ordinary journal event",
      resultCount: 0,
      results: [],
    };
    const observation = observeHostDataSql();
    const sql = observation.calls;
    try {
      expect(await readMemoryHostEventRecords({ workspaceDir, env: state.env })).toEqual([]);
      expect(existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);
      await appendMemoryHostEvent(workspaceDir, event, { env: state.env });
      await appendMemoryHostEvent(workspaceDir, event, { env: state.env });
      expect(await readMemoryHostEventRecords({ workspaceDir, env: state.env })).toEqual([
        event,
        event,
      ]);
      expectNoSql(sql);
      await closeOpenClawStateDatabaseAsync();
      expect(await readMemoryHostEventRecords({ workspaceDir, env: state.env })).toEqual([
        event,
        event,
      ]);
      expectNoSql(sql);
    } finally {
      observation.restore();
    }
    const { db } = openOpenClawStateDatabase({ env: state.env });
    const rows = db
      .prepare(
        "SELECT entry_key, value_json FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ? ORDER BY entry_key",
      )
      .all("memory-core", "memory-host.events");
    expect(rows).toHaveLength(2);
    for (const [index, row] of rows.entries()) {
      const sequence = index + 1;
      const value = JSON.parse(String(row.value_json)) as { recordedAt: number };
      expect(row.entry_key).toMatch(
        new RegExp(`^[a-f0-9]{24}:event:1:${String(sequence).padStart(16, "0")}$`),
      );
      expect(row.value_json).toBe(
        JSON.stringify({ kind: "event", event, recordedAt: value.recordedAt, sequence }),
      );
    }
    expect(
      db
        .prepare(
          "SELECT value_json FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ?",
        )
        .get("memory-core", "memory-host.event-cursors"),
    ).toEqual({ value_json: '{"kind":"cursor","lastSequence":2}' });
  });

  it("captures journal data and range before asynchronous admission", async ({ state }) => {
    const journalValue = { kind: "event", detail: { value: "captured" } };
    const journalKeyRange = { keyStartInclusive: "event:", keyEndExclusive: "event;" };
    const pending = registerPluginStateSequencedJournalEntry({
      pluginId: "memory-core",
      cursorOptions: {
        namespace: "memory-host.event-cursors",
        maxEntries: 1_000,
        env: state.env,
      },
      cursorKey: "workspace:cursor",
      journalOptions: { namespace: "memory-host.events", maxEntries: 10_000, env: state.env },
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
        pluginId: "memory-core",
        namespace: "memory-host.events",
        keyStartInclusive: "event:",
        keyEndExclusive: "event;",
        limit: 1,
        env: state.env,
      }),
    ).resolves.toMatchObject([
      {
        key: "event:1:0000000000000001",
        value: { kind: "event", detail: { value: "captured" }, sequence: 1 },
      },
    ]);
  });

  it("shares public keyed operations with the legacy store while SQL stays on the worker", async ({
    state: _state,
  }) => {
    const options = {
      namespace: "claims",
      maxEntries: 10,
      overflowPolicy: "reject-new" as const,
    };
    const observation = observeHostDataSql();
    const sql = observation.calls;
    try {
      const store = createPluginStateKeyedStore<number>("slack", options);
      const legacy = createPluginStateSyncKeyedStore<number>("slack", options);
      await store.register("upsert", 5);
      expect(await store.consume("upsert")).toBe(5);
      expect(await store.consume("upsert")).toBeUndefined();
      expect(await store.registerIfAbsent("worker", 2)).toBe(true);
      expectNoSql(sql);
      legacy.register("legacy", 1);
      expect(legacy.lookup("worker")).toBe(2);
      sql.forEach((method) => method.mockClear());
      expect(await store.registerIfAbsent("legacy", 3)).toBe(false);
      expect(await store.deleteIfEqual("worker", 1)).toBe(false);
      expect(await store.deleteIfEqual("worker", 2)).toBe(true);
      expect(await store.registerIfAbsent("fresh", 4)).toBe(true);
      await store.register("delete", 6);
      expect(await store.delete("delete")).toBe(true);
      expect(await store.delete("delete")).toBe(false);
      const cleared = createPluginStateKeyedStore<number>("slack", {
        ...options,
        namespace: "clear",
      });
      await cleared.register("removed", 7);
      await cleared.clear();
      expect(await cleared.entries()).toEqual([]);
      expect(await cleared.count()).toBe(0);
      expect(await store.lookupMany(["fresh", "legacy", "fresh"])).toEqual([
        { ok: true, value: 4 },
        { ok: true, value: 1 },
        { ok: true, value: 4 },
      ]);
      expect(await store.count()).toBe(2);
      expectNoSql(sql);
    } finally {
      observation.restore();
    }
    const persisted = createPluginStateSyncKeyedStore<number>("slack", options);
    expect(persisted.lookup("legacy")).toBe(1);
    expect(persisted.lookup("worker")).toBeUndefined();
    expect(persisted.lookup("fresh")).toBe(4);
    await closeOpenClawStateDatabaseAsync();
    expect(persisted.lookup("fresh")).toBe(4);
  });

  it("lets only one concurrent public consume receive a retained value", async ({
    state: _state,
  }) => {
    const store = openStore<{ count: number }>("slack", "consume");
    const value = { count: 1 };
    const registered = store.register("once", value);
    value.count = 99;
    await registered;
    const results = await Promise.all([store.consume("once"), store.consume("once")]);
    expect(results.filter((result) => result !== undefined)).toEqual([{ count: 1 }]);
    expect(results.filter((result) => result === undefined)).toHaveLength(1);
    expect(await store.lookup("once")).toBeUndefined();
  });

  it("keeps worker listing order and expiry while refreshing register TTLs", async ({
    state: _state,
  }) => {
    const namespace = "ttl-order";
    const now = Date.now();
    seedPluginStateEntriesForTests(
      [
        { key: "z", value: 1, createdAt: now - 2_000, expiresAt: now + 86_400_000 },
        { key: "a", value: 2, createdAt: now - 2_000 },
        { key: "expired", value: 3, createdAt: now - 3_000, expiresAt: now - 1 },
      ].map((entry) => Object.assign({ pluginId: "slack", namespace }, entry)),
    );
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

  it("bounds native listing bytes while preserving complete sync and worker entries", async ({
    state: _state,
  }) => {
    const pluginId = "memory-core";
    const namespace = "short-term-recall";
    const expected = Array.from({ length: 64 }, (_, index) => ({
      key: `entry-${String(index).padStart(2, "0")}`,
      value: { index, text: "value😀" },
      createdAt: 1000 + index,
    }));
    seedPluginStateEntriesForTests(expected.map((entry) => ({ pluginId, namespace, ...entry })));
    const options = { namespace, maxEntries: expected.length };
    const sync = createPluginStateSyncKeyedStore(pluginId, options);
    const store = createPluginStateKeyedStore(pluginId, options);
    const db = requireNativeSqliteDatabase(openOpenClawStateDatabase().db);
    const reads = trackSqliteStatementExecutions(db, ["listing"], (sql) =>
      sql.startsWith("select ") && sql.includes('"plugin_state_entries"') ? "listing" : null,
    );
    try {
      expect(sync.entries()).toEqual(expected);
      expect(reads.counts.listing).toBeGreaterThan(0);
      expect(reads.counts.listing).toBeLessThanOrEqual(1);
      expect(reads.rowCounts.listing).toBeGreaterThan(0);
      expect(reads.rowCounts.listing).toBeLessThanOrEqual(expected.length);
      expect(reads.textBytes.listing).toBeGreaterThan(0);
      expect.soft(reads.textBytes.listing).toBeLessThan(4096);
    } finally {
      reads.restore();
    }
    expect(await store.entries()).toEqual(expected);
  });

  it.for(["created_at", "expires_at"] as const)(
    "keeps later %s native errors ahead of earlier corrupt listing JSON",
    async (column, { state: _state }) => {
      const pluginId = "memory-core";
      const namespace = "listing-errors";
      seedPluginStateEntriesForTests(
        ["healthy", "corrupt", "unsafe"].map((key, index) => ({
          pluginId,
          namespace,
          key,
          value: { key },
          createdAt: 1000 + index,
        })),
      );
      const { db, path } = openOpenClawStateDatabase();
      db.prepare(
        "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
      ).run("invalid JSON", pluginId, namespace, "corrupt");
      const options = { namespace, maxEntries: 3 };
      const sync = createPluginStateSyncKeyedStore(pluginId, options);
      const store = createPluginStateKeyedStore(pluginId, options);
      const corrupt = { code: "PLUGIN_STATE_CORRUPT", operation: "entries", path };
      expect(() => sync.entries()).toThrowError(expect.objectContaining(corrupt));
      await expect(store.entries()).rejects.toMatchObject(corrupt);

      db.prepare(
        `UPDATE plugin_state_entries SET ${column} = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?`,
      ).run(9223372036854775807n, pluginId, namespace, "unsafe");
      const snapshot = db.prepare(
        "SELECT * FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ? ORDER BY entry_key",
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

  it("returns complete entries and positional bulk values larger than a broker frame", async ({
    state: _state,
  }) => {
    const namespace = "large-reads";
    const payloadBytes = 900_000;
    const count = Math.ceil(SQLITE_WORKER_MAX_RESULT_BYTES / payloadBytes) + 1;
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const values = Array.from({ length: count }, (_, index) => ({
      index,
      payload: `${index}:${"x".repeat(payloadBytes)}`,
    }));
    const keys = values.map((_, index) => `key-${index}`);
    seedPluginStateEntriesForTests(
      values.map((value, index) => ({
        pluginId: "slack",
        namespace,
        key: keys[index]!,
        value,
        createdAt: 1000 + index,
      })),
    );
    await closeOpenClawStateDatabaseAsync();
    const expected = values.map((value) => [value.index, digest(value.payload)]);
    const store = createPluginStateKeyedStore<{ index: number; payload: string }>("slack", {
      namespace,
      maxEntries: count,
    });
    const observation = observeHostDataSql();
    try {
      const entries = await store.entries();
      expect(serialize(entries).byteLength).toBeGreaterThan(SQLITE_WORKER_MAX_RESULT_BYTES);
      expect(entries.map((entry) => [entry.value.index, digest(entry.value.payload)])).toEqual(
        expected,
      );
      const request = [...keys.toReversed(), keys[0]!];
      const results = await store.lookupMany(request);
      expect(serialize(results).byteLength).toBeGreaterThan(SQLITE_WORKER_MAX_RESULT_BYTES);
      expect(
        results.map((result) =>
          result.ok && result.value ? [result.value.index, digest(result.value.payload)] : null,
        ),
      ).toEqual([...expected.toReversed(), expected[0]]);
      expectNoSql(observation.calls);
    } finally {
      observation.restore();
    }
  });

  it("preserves live-value equality, expiry, quota refusal, and corrupt JSON errors", async ({
    state: _state,
  }) => {
    const options = {
      namespace: "conditional",
      maxEntries: 1,
      overflowPolicy: "reject-new" as const,
    };
    const legacy = createPluginStateSyncKeyedStore<unknown>("slack", options);
    const store = createPluginStateKeyedStore<unknown>("slack", options);
    expect(await store.registerIfAbsent("entry", 1)).toBe(true);
    expect(await store.deleteIfEqual("entry", "1")).toBe(false);
    const { db, path } = openOpenClawStateDatabase();
    const refused = await store.registerIfAbsent("extra", 2).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PluginStateStoreError);
    expect(refused).toMatchObject({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
      operation: "register",
      path,
    });
    expect(legacy.lookup("entry")).toBe(1);
    expect(legacy.lookup("extra")).toBeUndefined();

    seedPluginStateEntriesForTests([
      {
        pluginId: "slack",
        namespace: options.namespace,
        key: "entry",
        value: 1,
        expiresAt: Date.now() - 1,
      },
    ]);
    expect(await store.deleteIfEqual("entry", 1)).toBe(false);
    expect(await store.registerIfAbsent("entry", null)).toBe(true);
    expect(await store.deleteIfEqual("entry", null)).toBe(true);

    legacy.register("entry", false);
    db.prepare(
      "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
    ).run("invalid JSON", "slack", options.namespace, "entry");
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
});
