import { afterEach, describe, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { preparePluginStateRead } from "../plugin-sdk/plugin-state-runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { pluginStatePublication } from "./plugin-state-publication.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
});

describe("prepared plugin state effect guards", () => {
  it.each(["reject-new", "evict-oldest"] as const)(
    "scopes a pending %s write without exposing its affected binding",
    async (overflowPolicy) => {
      await withOpenClawTestState({ label: "plugin-state-sibling-guard" }, async ({ env }) => {
        const store = createPluginStateKeyedStore<string>("guard-test", {
          namespace: "bindings",
          maxEntries: 10,
          overflowPolicy,
          env,
        });
        await store.register("a", "independent");
        await store.register("b-\ufffd", "original");
        const a = await preparePluginStateRead(store, "a");
        const b = await preparePluginStateRead(store, "b-\ufffd");
        if (!a || !b) {
          throw new Error("Expected prepared binding readers");
        }
        const foreign = openNodeSqliteDatabase(resolveOpenClawStateSqlitePath(env));
        foreign.exec("BEGIN IMMEDIATE");
        // A real SQLite writer lock prevents the sibling write from settling.
        const writing = store.register("b-\ud800", "replacement");
        try {
          expect(() => b.read()).toThrow("authority is unavailable");
          await expect(preparePluginStateRead(store, "b-\ufffd")).rejects.toThrow(
            "authority is unavailable",
          );
          if (overflowPolicy === "reject-new") {
            expect(a.read()).toBe("independent");
            const fresh = await preparePluginStateRead(store, "a");
            try {
              expect(fresh?.read()).toBe("independent");
            } finally {
              fresh?.release();
            }
          } else {
            // A register that can evict another key still denies the whole namespace.
            expect(() => a.read()).toThrow("authority is unavailable");
          }
        } finally {
          foreign.exec("ROLLBACK");
          foreign.close();
          await writing;
          a.release();
          b.release();
        }
        expect(await store.lookup("b-\ufffd")).toBe("replacement");
      });
    },
  );

  it("publishes native replacement and deletion only after commit, and restores a rolled-back guard", async () => {
    await withOpenClawTestState({ label: "plugin-state-native-guard" }, async ({ env }) => {
      const options = { namespace: "bindings", maxEntries: 10, env };
      const store = createPluginStateKeyedStore<string>("guard-test", options);
      const native = createPluginStateSyncKeyedStore<string>("guard-test", options);
      native.register("session", "original");
      const guard = await preparePluginStateRead(store, "session");
      if (!guard) {
        throw new Error("Expected the plugin-state owner to prepare a guard");
      }
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
      try {
        expect(guard.read()).toBe("original");
        native.register("session", "replacement");
        expect(guard.read()).toBe("replacement");
        expect(() =>
          runOpenClawStateWriteTransaction(
            () => {
              native.delete("session");
              expect(() => guard.read()).toThrow("authority is unavailable");
              throw new Error("rollback deletion");
            },
            { env },
          ),
        ).toThrow("rollback deletion");
        expect(guard.read()).toBe("replacement");
        native.delete("session");
        expect(guard.read()).toBeUndefined();
        expect(commits).toBe(2);
      } finally {
        guard.release();
      }
      expect(() => guard.read()).toThrow("committed state is unavailable");
    });
  });

  it("denies a queued worker write immediately and installs its postimage before releasing denial", async () => {
    await withOpenClawTestState({ label: "plugin-state-worker-guard" }, async ({ env }) => {
      const store = createPluginStateKeyedStore<string>("guard-test", {
        namespace: "bindings",
        maxEntries: 10,
        env,
      });
      await store.register("session", "original");
      const guard = await preparePluginStateRead(store, "session");
      if (!guard) {
        throw new Error("Expected the plugin-state owner to prepare a guard");
      }
      let publishedAtSettlement = false;
      const stop = pluginStatePublication.subscribeFacts((change) => {
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
      });
      try {
        const writing = store.register("session", "replacement");
        expect(() => guard.read()).toThrow("authority is unavailable");
        await writing;
        expect(publishedAtSettlement).toBe(true);
        expect(guard.read()).toBe("replacement");
      } finally {
        stop();
        guard.release();
      }
    });
  });

  it("keeps an uncertain publication denied after a later successful write or a fresh preparation", async () => {
    await withOpenClawTestState({ label: "plugin-state-unknown-guard" }, async ({ env }) => {
      const store = createPluginStateKeyedStore<string>("guard-test", {
        namespace: "bindings",
        maxEntries: 10,
        env,
      });
      await store.register("session", "original");
      const guard = await preparePluginStateRead(store, "session");
      if (!guard) {
        throw new Error("Expected the plugin-state owner to prepare a guard");
      }
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
      try {
        expect(() => guard.read()).toThrow("unavailable");
        await store.register("session", "later");
        expect(await store.lookup("session")).toBe("later");
        expect(() => guard.read()).toThrow("unavailable");
        await expect(preparePluginStateRead(store, "session")).rejects.toThrow("unavailable");
      } finally {
        guard.release();
      }
    });
  });

  it("publishes creation into a prepared absence and leaves opaque adapters with their native reader", async () => {
    await withOpenClawTestState({ label: "plugin-state-absent-guard" }, async ({ env }) => {
      const options = { namespace: "revocations", maxEntries: 10, env };
      const store = createPluginStateKeyedStore<boolean>("guard-test", options);
      const native = createPluginStateSyncKeyedStore<boolean>("guard-test", options);
      await store.register("other-room", true);
      const guard = await preparePluginStateRead(store, "room");
      if (!guard) {
        throw new Error("Expected the plugin-state owner to prepare a guard");
      }
      try {
        expect(guard.read()).toBeUndefined();
        native.register("room", true);
        expect(guard.read()).toBe(true);
        await store.delete("room");
        expect(guard.read()).toBeUndefined();
        await expect(preparePluginStateRead({ ...store }, "room")).resolves.toBeUndefined();
      } finally {
        guard.release();
      }
    });
  });
});
