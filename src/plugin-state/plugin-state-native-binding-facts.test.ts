import { afterEach, assert, expect, vi } from "vitest";
import { holdForeignWriter } from "../infra/sqlite-worker-shared-state-admission.test-support.js";
import { preparePluginStateRead } from "../plugin-sdk/plugin-state-runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { stateTest } from "./plugin-state-fixtures.test-support.js";
import { pluginStatePublication } from "./plugin-state-publication.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
  type OpenKeyedStoreOptions,
} from "./plugin-state-store.js";

const it = stateTest("plugin-state-native-binding");
const cleanups: (() => void)[] = [];

function openStore<T>(env: NodeJS.ProcessEnv, overrides: Partial<OpenKeyedStoreOptions> = {}) {
  return createPluginStateKeyedStore<T>("guard-test", {
    namespace: "bindings",
    maxEntries: 10,
    env,
    ...overrides,
  });
}

async function prepareGuard<T>(store: ReturnType<typeof openStore<T>>, key = "session") {
  const guard = await preparePluginStateRead(store, key);
  assert(guard, "Expected a prepared binding reader");
  cleanups.push(() => guard.release());
  return guard;
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
});

it.for(["reject-new", "evict-oldest"] as const)(
  "denies the pending %s binding at its eviction scope",
  async (overflowPolicy, { state: { env } }) => {
    const store = openStore<string>(env, { overflowPolicy });
    await store.register("a", "independent");
    await store.register("b-\ufffd", "original");
    const a = await prepareGuard(store, "a");
    const b = await prepareGuard(store, "b-\ufffd");
    const foreign = holdForeignWriter(captureOpenClawStateWorkerContext({ env }));
    // A real SQLite writer lock prevents the sibling write from settling.
    const writing = store.register("b-\ud800", "replacement");
    try {
      expect(() => b.read()).toThrow("authority is unavailable");
      await expect(preparePluginStateRead(store, "b-\ufffd")).rejects.toThrow(
        "authority is unavailable",
      );
      if (overflowPolicy === "reject-new") {
        expect(a.read()).toBe("independent");
        const fresh = await prepareGuard(store, "a");
        expect(fresh.read()).toBe("independent");
        fresh.release();
      } else {
        // A register that can evict another key still denies the whole namespace.
        expect(() => a.read()).toThrow("authority is unavailable");
      }
    } finally {
      foreign.close();
      await writing;
    }
    expect(await store.lookup("b-\ufffd")).toBe("replacement");
  },
);

it("publishes native commits, not rolled-back changes", async ({ state: { env } }) => {
  const options = { namespace: "bindings", maxEntries: 10, env };
  const store = createPluginStateKeyedStore<string>("guard-test", options);
  const native = createPluginStateSyncKeyedStore<string>("guard-test", options);
  native.register("session", "original");
  const guard = await prepareGuard(store, "session");
  const database = openOpenClawStateDatabase({ env });
  const exec = database.db.exec.bind(database.db);
  let commits = 0;
  vi.spyOn(database.db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT") {
      commits++;
      expect(() => guard.read()).toThrow("authority is unavailable");
    }
    return exec(sql);
  });
  expect(guard.read()).toBe("original");
  native.register("session", "replacement");
  expect(guard.read()).toBe("replacement");
  const abortDeletion = () => {
    native.delete("session");
    expect(() => guard.read()).toThrow("authority is unavailable");
    throw new Error("rollback deletion");
  };
  expect(() => runOpenClawStateWriteTransaction(abortDeletion, { env })).toThrow(
    "rollback deletion",
  );
  expect(guard.read()).toBe("replacement");
  native.delete("session");
  expect(guard.read()).toBeUndefined();
  expect(commits).toBe(2);
  guard.release();
  expect(() => guard.read()).toThrow("committed state is unavailable");
});

it("denies queued writes until postimage publication", async ({ state: { env } }) => {
  const store = openStore<string>(env);
  await store.register("session", "original");
  const guard = await prepareGuard(store, "session");
  let publishedAtSettlement = false;
  cleanups.push(
    pluginStatePublication.subscribeFacts((change) => {
      if (change.kind === "settled") {
        let current;
        try {
          current = guard.read();
        } catch (error) {
          // A queue hold can outlive the individual worker admission.
          expect(error).toMatchObject({ message: "Plugin state authority is unavailable" });
          return;
        }
        expect(current).toBe("replacement");
        publishedAtSettlement = true;
      } else {
        expect(() => guard.read()).toThrow("authority is unavailable");
      }
    }),
  );
  const writing = store.register("session", "replacement");
  expect(() => guard.read()).toThrow("authority is unavailable");
  await writing;
  expect(publishedAtSettlement).toBe(true);
  expect(guard.read()).toBe("replacement");
});

it("keeps unknown publications denied after recovery attempts", async ({ state: { env } }) => {
  const store = openStore<string>(env);
  await store.register("session", "original");
  const guard = await prepareGuard(store, "session");
  const stopFault = pluginStatePublication.subscribeFacts((change) => {
    if (change.kind === "committed") {
      throw new Error("synthetic fact installation failure");
    }
  });
  try {
    await store.register("session", "uncertain");
  } finally {
    stopFault();
  }
  expect(() => guard.read()).toThrow("unavailable");
  await store.register("session", "later");
  expect(await store.lookup("session")).toBe("later");
  expect(() => guard.read()).toThrow("unavailable");
  await expect(preparePluginStateRead(store, "session")).rejects.toThrow("unavailable");
});

it("updates prepared absences and preserves opaque adapters", async ({ state: { env } }) => {
  const options = { namespace: "revocations", maxEntries: 10, env };
  const store = createPluginStateKeyedStore<boolean>("guard-test", options);
  const native = createPluginStateSyncKeyedStore<boolean>("guard-test", options);
  await store.register("other-room", true);
  const guard = await prepareGuard(store, "room");
  expect(guard.read()).toBeUndefined();
  native.register("room", true);
  expect(guard.read()).toBe(true);
  await store.delete("room");
  expect(guard.read()).toBeUndefined();
  await expect(preparePluginStateRead({ ...store }, "room")).resolves.toBeUndefined();
});
