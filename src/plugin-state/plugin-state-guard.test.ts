import { afterEach, assert, expect, vi } from "vitest";
import { holdForeignWriter } from "../infra/sqlite-worker-shared-state-admission.test-support.js";
import {
  preparePluginStateGuard,
  preparePluginStateRead,
} from "../plugin-sdk/plugin-state-runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { stateTest } from "./plugin-state-fixtures.test-support.js";
import { pluginStatePublication } from "./plugin-state-publication.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";

const it = stateTest("plugin-state-guard");
type Value = { owner: string; metadata?: number };
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
});

async function fixture(env: NodeJS.ProcessEnv) {
  let active = true;
  const store = createPluginStateKeyedStore<Value>(
    "guard-test",
    {
      namespace: "bindings",
      maxEntries: 10,
      overflowPolicy: "reject-new",
      env,
    },
    () => {
      if (!active) {
        throw new Error("store closed");
      }
    },
  );
  await store.register("key", { owner: "current" });
  const guard = await preparePluginStateGuard(store, "key", (value) => {
    if (value?.owner !== "current") {
      throw new Error("owner changed");
    }
  });
  const read = await preparePluginStateRead(store, "key");
  assert(guard && read);
  cleanups.push(guard.release, () => read.release());
  return {
    store,
    guard,
    read,
    revoke: () => {
      active = false;
    },
  };
}

it("validates every queue and worker effect without changing ordinary read fences", async ({
  state: { env },
}) => {
  const { store, guard, read } = await fixture(env);
  const observed = await store.observe("key");
  const checks: boolean[] = [];
  const stop = pluginStatePublication.subscribeFacts((change) => {
    if (change.kind === "pending") {
      try {
        guard.assertCurrent();
        checks.push(true);
      } catch {
        checks.push(false);
      }
      expect(() => read.read()).toThrow("unavailable");
    }
  });
  const next = { owner: "current", metadata: 1 };
  const writing = store.compareAndApply("key", observed.comparison, {
    operation: "update",
    action: "set",
    value: next,
  });
  next.owner = "changed after serialization";
  try {
    guard.assertCurrent();
    expect(() => read.read()).toThrow("unavailable");
    await expect(writing).resolves.toMatchObject({ status: "applied" });
    expect(checks.length).toBeGreaterThanOrEqual(2);
    expect(checks.every(Boolean)).toBe(true);
    expect(read.read()).toEqual({ owner: "current", metadata: 1 });
    guard.assertCurrent();
  } finally {
    stop();
  }
});

it("denies a queued replacement behind an ownership-preserving update", async ({
  state: { env },
}) => {
  const { store, guard } = await fixture(env);
  const observed = await store.observe("key");
  const foreign = holdForeignWriter(captureOpenClawStateWorkerContext({ env }));
  const first = store.compareAndApply("key", observed.comparison, {
    operation: "update",
    action: "set",
    value: { owner: "current", metadata: 1 },
  });
  guard.assertCurrent();
  const second = store.compareAndApply("key", observed.comparison, {
    operation: "update",
    action: "set",
    value: { owner: "replacement" },
  });
  try {
    expect(guard.assertCurrent).toThrow("owner changed");
  } finally {
    foreign.close();
    await Promise.all([first, second]);
  }
  // The second CAS conflicts; settled unchanged ownership becomes available again.
  guard.assertCurrent();
});

it.for(["delete", "register", "clear", "ttl"] as const)(
  "denies pending %s effects",
  async (kind, { state: { env } }) => {
    const { store, guard } = await fixture(env);
    const observed = await store.observe("key");
    const foreign = holdForeignWriter(captureOpenClawStateWorkerContext({ env }));
    const writing =
      kind === "delete"
        ? store.delete("key")
        : kind === "register"
          ? store.register("key", { owner: "current" })
          : kind === "clear"
            ? store.clear()
            : store.compareAndApply("key", observed.comparison, {
                operation: "update",
                action: "set",
                value: { owner: "current" },
                ttlMs: 10_000,
              });
    try {
      expect(guard.assertCurrent).toThrow("unavailable");
    } finally {
      foreign.close();
      await writing;
    }
    if (kind === "delete" || kind === "clear") {
      expect(guard.assertCurrent).toThrow("owner changed");
    } else {
      guard.assertCurrent();
    }
  },
);

it("never grants from a proposed postimage when committed ownership is absent", async ({
  state: { env },
}) => {
  const { store } = await fixture(env);
  const guard = await preparePluginStateGuard(store, "absent", (value) => {
    if (!value) {
      throw new Error("absent owner");
    }
  });
  assert(guard);
  cleanups.push(guard.release);
  const observed = await store.observe("absent");
  const writing = store.compareAndApply("absent", observed.comparison, {
    operation: "update",
    action: "set",
    value: { owner: "current" },
  });
  expect(guard.assertCurrent).toThrow("absent owner");
  await writing;
  guard.assertCurrent();
});

it("retains source retirement and release denial", async ({ state: { env } }) => {
  const { store, guard, revoke } = await fixture(env);
  const released = await preparePluginStateGuard(store, "key", () => {});
  assert(released);
  released.assertCurrent();
  released.release();
  expect(released.assertCurrent).toThrow("unavailable");
  guard.assertCurrent();
  revoke();
  expect(guard.assertCurrent).toThrow("store closed");
});

it("retains expiry and unknown-settlement denial", async ({ state: { env } }) => {
  const { store, guard } = await fixture(env);
  await store.register("key", { owner: "current" }, { ttlMs: 10_000 });
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 20_000);
  expect(guard.assertCurrent).toThrow("owner changed");
  clock.mockRestore();
  guard.assertCurrent();
  const stopFault = pluginStatePublication.subscribeFacts((change) => {
    if (change.kind === "committed") {
      throw new Error("fact installation failed");
    }
  });
  try {
    await store.register("key", { owner: "current" });
  } finally {
    stopFault();
  }
  expect(guard.assertCurrent).toThrow("unavailable");
  await store.register("key", { owner: "current" });
  expect(guard.assertCurrent).toThrow("unavailable");
});
