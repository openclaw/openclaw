import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createPluginStateKernelStore } from "./plugin-state-kernel.test-helpers.js";
import { resetPluginStateStoreForTests } from "./plugin-state-store.js";
import { deleteExpiredPluginStateEntries } from "./plugin-state-store.kernel.js";
import { clearPluginStateStoreForTests } from "./plugin-state-store.test-helpers.js";

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "plugin-state-kernel-clock" });
});
beforeEach(() => {
  clearPluginStateStoreForTests();
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  resetPluginStateStoreForTests();
  await state.cleanup();
});
const physicalRows = () =>
  openOpenClawStateDatabase({ env: state.env })
    .db.prepare(
      "SELECT created_at, expires_at, expires_at - created_at AS ttl_ms FROM plugin_state_entries ORDER BY namespace, entry_key",
    )
    .all();
const store = (namespace: string, maxEntries = 10) =>
  createPluginStateKernelStore<number>("fixture-plugin", {
    env: state.env,
    namespace,
    maxEntries,
    overflowPolicy: "reject-new",
    defaultTtlMs: 200,
  });

describe("keyed kernel clock fixture", () => {
  it("keeps physical rows until exact expiry, then filters reads without pretending to delete", async () => {
    const metadata = store("metadata");
    const chunks = store("chunks");
    for (let index = 0; index < 3; index++) {
      await chunks.register(String(index), index);
    }
    await metadata.register("meta", 3);
    expect(physicalRows()).toEqual(
      Array.from({ length: 4 }, () => ({ created_at: 1_000, expires_at: 1_200, ttl_ms: 200 })),
    );
    vi.setSystemTime(1_101);
    expect(await metadata.entries()).toHaveLength(1);
    expect(await chunks.entries()).toHaveLength(3);
    vi.setSystemTime(1_199);
    await expect(chunks.lookup("0")).resolves.toBe(0);
    vi.setSystemTime(1_200);
    await expect(metadata.entries()).resolves.toEqual([]);
    await expect(chunks.entries()).resolves.toEqual([]);
    await expect(chunks.lookup("0")).resolves.toBeUndefined();
    expect(physicalRows()).toHaveLength(4);
    expect(
      runOpenClawStateWriteTransaction(
        ({ db }) => deleteExpiredPluginStateEntries(db, Date.now()),
        { env: state.env },
      ),
    ).toBe(4);
    expect(physicalRows()).toEqual([]);
  });

  it("uses real quota, conditional insert, positional read and deletion kernels", async () => {
    const keyed = store("quota", 1);
    await expect(keyed.registerIfAbsent("a", 1)).resolves.toBe(true);
    await expect(keyed.registerIfAbsent("a", 2)).resolves.toBe(false);
    await expect(keyed.register("b", 2)).rejects.toMatchObject({
      code: "PLUGIN_STATE_LIMIT_EXCEEDED",
    });
    await expect(keyed.lookupMany?.(["a", "missing", "a"])).resolves.toEqual([
      { ok: true, value: 1 },
      { ok: true, value: undefined },
      { ok: true, value: 1 },
    ]);
    await expect(keyed.consume("a")).resolves.toBe(1);
    await expect(keyed.consume("a")).resolves.toBeUndefined();
    await keyed.register("b", 2, { ttlMs: 100 });
    expect(physicalRows()).toEqual([{ created_at: 1_000, expires_at: 1_100, ttl_ms: 100 }]);
    await expect(keyed.delete("b")).resolves.toBe(true);
    await expect(keyed.delete("b")).resolves.toBe(false);
    await keyed.register("c", 3);
    await keyed.clear();
    expect(physicalRows()).toEqual([]);
  });

  it("models a two-clock interleaving with one metadata row but only two visible chunks", async () => {
    // Controlled kernel counterexample, NOT an attribution of the actual CI failure.
    // Caller logical time stays 1101 (inside grace); storage time progresses independently.
    const callerNow = 1_101;
    const logicalExpiry = 1_100;
    const metadata = store("modeled-metadata");
    const chunks = store("modeled-chunks");
    for (let index = 0; index < 3; index++) {
      vi.setSystemTime(2_000 + index * 50);
      await chunks.register(String(index), index);
    }
    vi.setSystemTime(2_150);
    await metadata.register("meta", logicalExpiry);
    vi.setSystemTime(2_220);
    expect(callerNow - logicalExpiry).toBeLessThan(100);
    expect(await metadata.entries()).toHaveLength(1);
    expect(await chunks.entries()).toHaveLength(2);
    // The missing chunk is filtered, not physically removed in this interleaving.
    expect(physicalRows()).toEqual([
      { created_at: 2_000, expires_at: 2_200, ttl_ms: 200 },
      { created_at: 2_050, expires_at: 2_250, ttl_ms: 200 },
      { created_at: 2_100, expires_at: 2_300, ttl_ms: 200 },
      { created_at: 2_150, expires_at: 2_350, ttl_ms: 200 },
    ]);
  });
});
