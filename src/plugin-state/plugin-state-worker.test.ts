import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { deserialize, serialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { SQLITE_WORKER_MAX_RESULT_BYTES } from "../infra/sqlite-worker-contract.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import {
  appendMemoryHostEvent,
  readMemoryHostEventRecords,
} from "../plugin-sdk/memory-host-events.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  pluginStateEntriesInKeyRange,
  registerPluginStateSequencedJournalEntry,
  sweepExpiredPluginStateEntries,
} from "./plugin-state-store.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

describe("worker plugin state", () => {
  it("opens cold state and sweeps reopened state without host data SQL", async () => {
    await withOpenClawTestState({ label: "plugin-state-worker-sweep" }, async (state) => {
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      const observation = observeHostDataSql(state.env);
      try {
        expect(existsSync(databasePath)).toBe(false);
        expect(await sweepExpiredPluginStateEntries({ env: state.env })).toBe(0);
        expect(existsSync(databasePath)).toBe(true);
        for (const method of observation.calls) {
          expect(method).not.toHaveBeenCalled();
        }

        const now = Date.now();
        seedPluginStateEntriesForTests([
          {
            pluginId: "fixture-plugin",
            namespace: "sweep",
            key: "expired",
            value: { expired: true },
            expiresAt: now - 1,
          },
          {
            pluginId: "fixture-plugin",
            namespace: "sweep",
            key: "live",
            value: { live: true },
            expiresAt: now + 86_400_000,
          },
        ]);
        await closeOpenClawStateDatabaseAsync();
        for (const method of observation.calls) {
          method.mockClear();
        }
        expect(await sweepExpiredPluginStateEntries({ env: state.env })).toBe(1);
        expect(await sweepExpiredPluginStateEntries({ env: state.env })).toBe(0);
        for (const method of observation.calls) {
          expect(method).not.toHaveBeenCalled();
        }
      } finally {
        observation.restore();
      }
      const persisted = createPluginStateSyncKeyedStore("fixture-plugin", {
        namespace: "sweep",
        maxEntries: 10,
        env: state.env,
      });
      expect(persisted.lookup("expired")).toBeUndefined();
      expect(persisted.lookup("live")).toEqual({ live: true });
    });
  });

  it.each(["observe", "compareDelete"] as const)(
    "waits for an overlapping host owner before worker lifecycle acquisition during %s",
    async (operation) => {
      await withOpenClawTestState({ label: "plugin-state-lock-custody" }, async (state) => {
        const assertActive = vi.fn();
        const store = createPluginStateKeyedStore<string>(
          "memory-core",
          {
            namespace: "lock-custody",
            retention: "retained",
            env: state.env,
          },
          assertActive,
        );
        const messages = vi.spyOn(Worker.prototype, "postMessage");
        await store.register("workspace", "owner");
        const worker = messages.mock.contexts[0];
        messages.mockRestore();
        if (!(worker instanceof Worker)) {
          throw new Error("Expected the shared-state worker");
        }
        const observation = await store.observe("workspace");
        let held: ReturnType<typeof acquireStateDatabaseCoordinator> | undefined;
        const nativePost = worker.postMessage.bind(worker);
        const dispatch = vi
          .spyOn(worker, "postMessage")
          .mockImplementation((message, transferList) => {
            const request = asOptionalRecord(message);
            if (
              request?.type === "execute" &&
              request.input instanceof Uint8Array &&
              asOptionalRecord(deserialize(request.input))?.type === "pluginState." + operation
            ) {
              // This owner arrives too late to be delegated. Fresh worker acquisition
              // must wait for its release while the host keeps servicing authority checks.
              held = acquireStateDatabaseCoordinator({
                databasePath: resolveOpenClawStateSqlitePath(state.env),
                busyTimeoutMs: 0,
              });
              assertActive.mockClear();
            }
            return nativePost(message, transferList);
          });
        let completed = false;
        const pending = (
          operation === "observe"
            ? store.observe("workspace")
            : store.compareAndApply("workspace", observation.comparison, {
                operation: "delete",
                action: "delete",
              })
        ).then(
          (value) => {
            completed = true;
            return { ok: true, value } as const;
          },
          (error: unknown) => {
            completed = true;
            return { ok: false, error } as const;
          },
        );
        try {
          await vi.waitFor(() => expect(held).toBeDefined());
          await vi.waitFor(() => expect(assertActive.mock.calls.length).toBeGreaterThan(4));
          expect(completed).toBe(false);
          held?.release();
          held = undefined;
          if (operation === "observe") {
            await expect(pending).resolves.toMatchObject({ ok: true, value: { value: "owner" } });
          } else {
            await expect(pending).resolves.toEqual({ ok: true, value: { status: "applied" } });
          }
        } finally {
          dispatch.mockRestore();
          held?.release();
          await pending;
        }
        expect(await store.lookup("workspace")).toBe(operation === "observe" ? "owner" : undefined);
      });
    },
  );

  it("appends and reads the memory journal off-thread with unchanged persisted bytes", async () => {
    await withOpenClawTestState({ label: "memory-journal-worker" }, async (state) => {
      const workspaceDir = state.workspaceDir;
      const event = {
        type: "memory.recall.recorded" as const,
        timestamp: "2026-09-13T12:00:00.000Z",
        query: "ordinary journal event",
        resultCount: 0,
        results: [],
      };
      const observation = observeHostDataSql(state.env);
      const sql = observation.calls;
      const timings: Record<string, number> = {};
      try {
        expect(await readMemoryHostEventRecords({ workspaceDir, env: state.env })).toEqual([]);
        expect(existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);
        let started = performance.now();
        await appendMemoryHostEvent(workspaceDir, event, { env: state.env });
        timings.coldAppendMs = performance.now() - started;
        started = performance.now();
        await appendMemoryHostEvent(workspaceDir, event, { env: state.env });
        timings.warmAppendMs = performance.now() - started;
        started = performance.now();
        expect(await readMemoryHostEventRecords({ workspaceDir, env: state.env })).toEqual([
          event,
          event,
        ]);
        timings.warmReadMs = performance.now() - started;
        for (const method of sql) {
          expect(method).not.toHaveBeenCalled();
        }
        await closeOpenClawStateDatabaseAsync();
        started = performance.now();
        expect(await readMemoryHostEventRecords({ workspaceDir, env: state.env })).toEqual([
          event,
          event,
        ]);
        timings.coldReadMs = performance.now() - started;
        for (const method of sql) {
          expect(method).not.toHaveBeenCalled();
        }
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
      console.log("memory-journal-worker timings", JSON.stringify(timings));
    });
  });

  it("captures journal data and range before asynchronous admission", async () => {
    await withOpenClawTestState({ label: "memory-journal-capture" }, async (state) => {
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
  });

  it("shares public keyed operations with the legacy store while SQL stays on the worker", async () => {
    await withOpenClawTestState({ label: "plugin-state-worker-coexistence" }, async () => {
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
        expect(() => createPluginStateKeyedStore("slack", { ...options, maxEntries: 0 })).toThrow(
          PluginStateStoreError,
        );
        await expect(store.lookup(" ")).rejects.toMatchObject({
          code: "PLUGIN_STATE_INVALID_INPUT",
          operation: "lookup",
        });
        expect(existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
        expect(await store.lookup("missing")).toBeUndefined();
        expect(await store.lookupMany(["missing", "missing"])).toEqual([
          { ok: true, value: undefined },
          { ok: true, value: undefined },
        ]);
        expect(await store.entries()).toEqual([]);
        expect(await store.count()).toBe(0);
        expect(existsSync(resolveOpenClawStateSqlitePath())).toBe(false);
        await store.register("upsert", 5);
        expect(await store.lookup("upsert")).toBe(5);
        expect(await store.count()).toBe(1);
        expect(await store.entries()).toEqual([
          { key: "upsert", value: 5, createdAt: expect.any(Number) },
        ]);
        expect(await store.consume("upsert")).toBe(5);
        expect(await store.consume("upsert")).toBeUndefined();
        expect(await store.registerIfAbsent("worker", 2)).toBe(true);
        for (const method of sql) {
          expect(method).not.toHaveBeenCalled();
        }
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
        for (const method of sql) {
          expect(method).not.toHaveBeenCalled();
        }
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
  });

  it("lets only one concurrent public consume receive a retained value", async () => {
    await withOpenClawTestState({ label: "plugin-state-worker-consume" }, async () => {
      const store = createPluginStateKeyedStore<{ count: number }>("slack", {
        namespace: "consume",
        maxEntries: 10,
      });
      const value = { count: 1 };
      const registered = store.register("once", value);
      value.count = 99;
      await registered;
      const results = await Promise.all([store.consume("once"), store.consume("once")]);
      expect(results.filter((result) => result !== undefined)).toEqual([{ count: 1 }]);
      expect(results.filter((result) => result === undefined)).toHaveLength(1);
      expect(await store.lookup("once")).toBeUndefined();
    });
  });

  it("keeps worker listing order and expiry while refreshing register TTLs", async () => {
    await withOpenClawTestState({ label: "plugin-state-worker-ttl-order" }, async () => {
      const namespace = "ttl-order";
      const now = Date.now();
      seedPluginStateEntriesForTests([
        {
          pluginId: "slack",
          namespace,
          key: "z",
          value: 1,
          createdAt: now - 2_000,
          expiresAt: now + 86_400_000,
        },
        { pluginId: "slack", namespace, key: "a", value: 2, createdAt: now - 2_000 },
        {
          pluginId: "slack",
          namespace,
          key: "expired",
          value: 3,
          createdAt: now - 3_000,
          expiresAt: now - 1,
        },
      ]);
      const store = createPluginStateKeyedStore<number>("slack", {
        namespace,
        maxEntries: 10,
        defaultTtlMs: 60_000,
      });
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
  });

  it("bounds native listing bytes while preserving complete sync and worker entries", async () => {
    await withOpenClawTestState({ label: "plugin-state-worker-listing-bytes" }, async () => {
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
      const { db } = openOpenClawStateDatabase();
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
  });

  it.each(["created_at", "expires_at"] as const)(
    "keeps later %s native errors ahead of earlier corrupt listing JSON",
    async (column) => {
      await withOpenClawTestState({ label: `plugin-state-worker-listing-${column}` }, async () => {
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

        const update = db.prepare(
          column === "created_at"
            ? "UPDATE plugin_state_entries SET created_at = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?"
            : "UPDATE plugin_state_entries SET expires_at = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
        );
        update.run(9223372036854775807n, pluginId, namespace, "unsafe");
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
      });
    },
  );

  it("returns complete entries and positional bulk values larger than a broker frame", async () => {
    await withOpenClawTestState({ label: "plugin-state-worker-large-reads" }, async () => {
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
      const native = requireNodeSqlite();
      const sql = [
        vi.spyOn(native.DatabaseSync.prototype, "prepare"),
        vi.spyOn(native.DatabaseSync.prototype, "exec"),
        ...(["get", "all", "run", "iterate"] as const).map((method) =>
          vi.spyOn(native.StatementSync.prototype, method),
        ),
      ];
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
        for (const method of sql) {
          expect(method).not.toHaveBeenCalled();
        }
      } finally {
        sql.forEach((method) => method.mockRestore());
      }
    });
  });

  it("preserves live-value equality, expiry, quota refusal, and corrupt JSON errors", async () => {
    await withOpenClawTestState({ label: "plugin-state-worker-contract" }, async () => {
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
      });
    });
  });
});
