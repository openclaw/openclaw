import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  closePluginStateDatabase,
  createPluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";
import {
  clearPluginStateStoreForTests,
  seedPluginStateEntriesForTests,
} from "./plugin-state-store.test-helpers.js";

let testState: OpenClawTestState;
beforeAll(async () => {
  testState = await createOpenClawTestState({ label: "plugin-state-prepared" });
});
beforeEach(() => {
  testState.applyEnv();
  clearPluginStateStoreForTests();
});
afterEach(() => {
  resetPluginStateStoreForTests();
});
afterAll(async () => {
  await testState.cleanup();
});

describe("plugin state prepared queries", () => {
  it("compiles exact reads once per connection with fresh scope and expiry bindings", () => {
    const now = Date.now();
    seedPluginStateEntriesForTests([
      { pluginId: "discord", namespace: "prepared", key: "first", value: 1, expiresAt: now + 100 },
      { pluginId: "discord", namespace: "prepared", key: "second", value: 2 },
      { pluginId: "telegram", namespace: "prepared", key: "first", value: 3 },
      { pluginId: "discord", namespace: "sibling", key: "first", value: 4 },
    ]);
    const store = createPluginStateSyncKeyedStore<number>("discord", {
      namespace: "prepared",
      maxEntries: 10,
    });
    const pluginSibling = createPluginStateSyncKeyedStore<number>("telegram", {
      namespace: "prepared",
      maxEntries: 10,
    });
    const namespaceSibling = createPluginStateSyncKeyedStore<number>("discord", {
      namespace: "sibling",
      maxEntries: 10,
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      for (let connection = 0; connection < 2; connection++) {
        closePluginStateDatabase();
        const { db } = openOpenClawStateDatabase();
        const compile = vi.spyOn(getNodeSqliteKysely(db).getExecutor(), "compileQuery");
        try {
          clock.mockReturnValue(now);
          expect(store.lookup("first")).toBe(1);
          expect(store.lookup("second")).toBe(2);
          expect(pluginSibling.lookup("first")).toBe(3);
          expect(namespaceSibling.lookup("first")).toBe(4);
          expect(store.lookup("missing")).toBeUndefined();
          clock.mockReturnValue(now + 100);
          expect(store.lookup("first")).toBeUndefined();
          expect(store.lookup("second")).toBe(2);
          expect(compile).toHaveBeenCalledOnce();
        } finally {
          compile.mockRestore();
        }
      }
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["register", "registerIfAbsent"] as const)(
    "reuses %s compilation with fresh write bindings after reopening",
    (operation) => {
      const options = { namespace: "prepared-writes", maxEntries: 20 };
      const stores = [
        createPluginStateSyncKeyedStore<string>("discord", options),
        createPluginStateSyncKeyedStore<string>("telegram", options),
        createPluginStateSyncKeyedStore<string>("discord", {
          ...options,
          namespace: "prepared-sibling",
        }),
      ];
      const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
      try {
        for (let connection = 0; connection < 2; connection++) {
          closePluginStateDatabase();
          const { db } = openOpenClawStateDatabase();
          const compile = vi.spyOn(getNodeSqliteKysely(db).getExecutor(), "compileQuery");
          try {
            const key = `round-${connection}`;
            for (const [index, store] of stores.entries()) {
              clock.mockReturnValue(10_000 + index);
              store[operation](key, `value-${index}`, { ttlMs: 100 });
              clock.mockReturnValue(10_010 + index);
              store[operation](`${key}-durable`, `durable-${index}`);
              const result = store[operation](key, `replacement-${index}`);
              if (operation === "registerIfAbsent") {
                expect(result).toBe(false);
              }
              const expected =
                operation === "registerIfAbsent"
                  ? {
                      key,
                      value: `value-${index}`,
                      createdAt: 10_000 + index,
                      expiresAt: 10_100 + index,
                    }
                  : { key, value: `replacement-${index}`, createdAt: 10_010 + index };
              expect(store.entries().filter((entry) => entry.key.startsWith(key))).toEqual([
                expected,
                { key: `${key}-durable`, value: `durable-${index}`, createdAt: 10_010 + index },
              ]);
            }
            const writes = compile.mock.results.filter(
              (result) => result.type === "return" && result.value.sql.startsWith("insert"),
            );
            expect(writes).toHaveLength(1);
          } finally {
            compile.mockRestore();
          }
        }
      } finally {
        clock.mockRestore();
      }
    },
  );
});
