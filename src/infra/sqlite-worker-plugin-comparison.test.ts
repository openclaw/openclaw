import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
} from "../plugin-state/plugin-state-store.js";
import {
  bindPluginStateEntry,
  getPluginStateKysely,
  upsertPluginStateEntry,
} from "../plugin-state/plugin-state-store.kernel.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function fixture(
  namespace: string,
  options: {
    maxEntries?: number;
    defaultTtlMs?: number;
    overflowPolicy?: "reject-new" | "evict-oldest";
  } = {},
) {
  const env = { OPENCLAW_STATE_DIR: dirs.make("openclaw-plugin-comparison-") };
  const params = { namespace, maxEntries: 4, env, ...options };
  return {
    env,
    store: createPluginStateKeyedStore<{ count: number }>("comparison-proof", params),
    legacy: createPluginStateSyncKeyedStore<{ count: number }>("comparison-proof", params),
    native: () => openOpenClawStateDatabase({ env }),
    seed(key: string, valueJson: string, createdAt: number, expiresAt: number | null) {
      upsertPluginStateEntry(
        openOpenClawStateDatabase({ env }).db,
        bindPluginStateEntry({
          pluginId: "comparison-proof",
          namespace,
          key,
          valueJson,
          createdAt,
          expiresAt,
        }),
      );
    },
  };
}

describe("plugin state data-only comparison", () => {
  it("observes and applies through the real worker without parent SQL", async () => {
    const { store } = fixture("cold");
    const observation = observeHostDataSql();
    const calls = observation.calls;
    try {
      const observed = await store.observe("counter");
      expect(observed.value).toBeUndefined();
      expect(
        await store.compareAndApply("counter", observed.comparison, {
          operation: "update",
          action: "set",
          value: { count: 1 },
        }),
      ).toEqual({ status: "applied" });
      expect(await store.lookup("counter")).toEqual({ count: 1 });
      for (const call of calls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      observation.restore();
    }
  });

  it("returns the current row after a legacy write without losing that update", async () => {
    const { store, legacy } = fixture("conflict");
    legacy.register("counter", { count: 1 });
    const before = await store.observe("counter");
    legacy.register("counter", { count: 2 });
    const conflict = await store.compareAndApply("counter", before.comparison, {
      operation: "update",
      action: "set",
      value: { count: 3 },
    });
    expect(conflict.status).toBe("conflict");
    if (conflict.status !== "conflict") {
      throw new Error("Expected an observed conflict");
    }
    expect(conflict.current.value).toEqual({ count: 2 });
    expect(await store.lookup("counter")).toEqual({ count: 2 });
    expect(
      await store.compareAndApply("counter", conflict.current.comparison, {
        operation: "update",
        action: "set",
        value: { count: 3 },
      }),
    ).toEqual({ status: "applied" });
  });

  it("compares stored bytes without requiring legacy JSON to be reserialized", async () => {
    const f = fixture("legacy-json");
    f.seed("counter", ' { "count" : 1 } ', 1, null);
    const before = await f.store.observe("counter");
    expect(
      await f.store.compareAndApply("counter", before.comparison, {
        operation: "update",
        action: "set",
        value: { count: 2 },
      }),
    ).toEqual({ status: "applied" });
  });

  it("refreshes age and default TTL for a defined same-value update", async () => {
    const f = fixture("refresh", { defaultTtlMs: 60_000 });
    f.seed("counter", '{"count":1}', 1, Date.now() + 120_000);
    const before = await f.store.observe("counter");
    expect(
      await f.store.compareAndApply("counter", before.comparison, {
        operation: "update",
        action: "set",
        value: { count: 1 },
      }),
    ).toEqual({ status: "applied" });
    const [entry] = await f.store.entries();
    expect(entry?.createdAt).toBeGreaterThan(1);
    expect(entry?.expiresAt).toBe((entry?.createdAt ?? 0) + 60_000);
  });

  it("keeps expiry cleanup distinct from conditional-delete keep and from conflict", async () => {
    const f = fixture("keep");
    f.seed("counter", '{"count":1}', 1, null);
    const before = await f.store.observe("counter");
    f.seed("expired", '{"count":0}', 0, Date.now() - 1);
    expect(
      await f.store.compareAndApply("counter", before.comparison, {
        operation: "delete",
        action: "keep",
      }),
    ).toEqual({ status: "unchanged" });
    const native = f.native();
    const rows = () =>
      executeSqliteQuerySync(
        native.db,
        getPluginStateKysely(native.db)
          .selectFrom("plugin_state_entries")
          .select("entry_key")
          .orderBy("entry_key"),
      ).rows;
    expect(rows()).toHaveLength(2);
    f.seed("counter", '{"count":2}', 1, null);
    expect(
      (
        await f.store.compareAndApply("counter", before.comparison, {
          operation: "update",
          action: "keep",
        })
      ).status,
    ).toBe("conflict");
    expect(rows()).toHaveLength(2);
    const current = await f.store.observe("counter");
    expect(
      await f.store.compareAndApply("counter", current.comparison, {
        operation: "update",
        action: "keep",
      }),
    ).toEqual({ status: "unchanged" });
    expect(rows()).toEqual([{ entry_key: "counter" }]);
  });

  it("treats expired state as stable absence and conflicts with a formerly live image", async () => {
    const f = fixture("expiry");
    f.seed("counter", '{"count":1}', 1, Date.now() + 60_000);
    const live = await f.store.observe("counter");
    f.seed("counter", '{"count":1}', 1, Date.now() - 1);
    const expired = await f.store.compareAndApply("counter", live.comparison, {
      operation: "update",
      action: "set",
      value: { count: 2 },
    });
    expect(expired.status).toBe("conflict");
    if (expired.status !== "conflict") {
      throw new Error("Expected expiry to conflict");
    }
    expect(expired.current.value).toBeUndefined();
    expect(
      await f.store.compareAndApply("counter", expired.current.comparison, {
        operation: "update",
        action: "keep",
      }),
    ).toEqual({ status: "unchanged" });
    expect(
      await f.store.compareAndApply("counter", expired.current.comparison, {
        operation: "update",
        action: "set",
        value: { count: 2 },
      }),
    ).toEqual({ status: "applied" });
  });

  it("rejects another key or retargeted database observation instead of returning retryable conflict", async () => {
    const f = fixture("scope");
    await f.store.register("counter", { count: 1 });
    const observed = await f.store.observe("counter");
    await expect(
      f.store.compareAndApply("other", observed.comparison, {
        operation: "update",
        action: "keep",
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT" });
    f.env.OPENCLAW_STATE_DIR = dirs.make("openclaw-plugin-retarget-");
    await f.store.register("counter", { count: 1 });
    await expect(
      f.store.compareAndApply("counter", observed.comparison, {
        operation: "update",
        action: "keep",
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT" });
  });

  it("keeps reject-new updates and rolls back a denied insertion", async () => {
    const { store } = fixture("quota", { maxEntries: 1, overflowPolicy: "reject-new" });
    await store.register("first", { count: 1 });
    const first = await store.observe("first");
    expect(
      await store.compareAndApply("first", first.comparison, {
        operation: "update",
        action: "set",
        value: { count: 2 },
      }),
    ).toEqual({ status: "applied" });
    const missing = await store.observe("second");
    await expect(
      store.compareAndApply("second", missing.comparison, {
        operation: "update",
        action: "set",
        value: { count: 3 },
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_STATE_LIMIT_EXCEEDED" });
    expect(await store.entries()).toMatchObject([{ key: "first", value: { count: 2 } }]);
  });

  it("retains writable admission for both keep intents", async () => {
    const f = fixture("keep-ownership");
    f.legacy.register("counter", { count: 1 });
    const observed = await f.store.observe("counter");
    claimOpenClawStateOwnership("comparison-owner", {
      env: { ...f.env, OPENCLAW_SUPERVISOR_MODE: "external" },
    });
    for (const operation of ["update", "delete"] as const) {
      await expect(
        f.store.compareAndApply("counter", observed.comparison, { operation, action: "keep" }),
      ).rejects.toMatchObject({ code: "PLUGIN_STATE_WRITE_FAILED" });
    }
  });

  it("preserves corruption failures rather than turning them into conflicts", async () => {
    const f = fixture("corrupt");
    f.seed("counter", '{"count":1}', 1, null);
    const observed = await f.store.observe("counter");
    f.seed("counter", "{", 1, null);
    await expect(
      f.store.compareAndApply("counter", observed.comparison, {
        operation: "update",
        action: "set",
        value: { count: 2 },
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_STATE_CORRUPT", operation: "lookup" });
  });
});
