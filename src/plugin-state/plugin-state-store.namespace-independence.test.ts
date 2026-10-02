import { afterEach, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  getPluginStateCapacity,
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  importPluginStateEntriesForDoctor,
  registerPluginStateSequencedJournalEntry,
  resetPluginStateStoreForTests,
} from "./plugin-state-store.js";
import { seedPluginStateEntriesForTests } from "./plugin-state-store.test-helpers.js";

afterEach(() => resetPluginStateStoreForTests());

it("keeps execution and migration writable beyond 50,000 sibling catalog rows", async () => {
  await withOpenClawTestState({ label: "plugin-state-namespace-independence" }, async () => {
    seedPluginStateEntriesForTests(
      Array.from({ length: 50_000 }, (_, index) => ({
        pluginId: "codex",
        namespace: `catalog-${Math.floor(index / 20_000)}`,
        key: `thread-${index}`,
        value: index,
      })),
    );
    const options = {
      namespace: "execution",
      maxEntries: 10,
      overflowPolicy: "reject-new" as const,
    };
    const sync = createPluginStateSyncKeyedStore<number>("codex", options);
    sync.register("process", 1);
    expect(sync.registerIfAbsent("claim", 2)).toBe(true);
    expect(sync.update?.("updated", () => 3)).toBe(true);

    const worker = createPluginStateKeyedStore<number>("codex", options);
    await worker.register("binding", 4);
    expect(await worker.registerIfAbsent("worker-claim", 5)).toBe(true);
    const observed = await worker.observe!("compared");
    expect(
      await worker.compareAndApply!("compared", observed.comparison, {
        operation: "update",
        action: "set",
        value: 6,
      }),
    ).toEqual({ status: "applied" });
    expect(
      (await worker.entries()).map(({ value }) => value).toSorted((left, right) => left - right),
    ).toEqual([1, 2, 3, 4, 5, 6]);

    importPluginStateEntriesForDoctor("codex", options, [
      { key: "imported", value: 7, createdAt: 1 },
    ]);
    expect(sync.lookup("imported")).toBe(7);
    expect(
      await registerPluginStateSequencedJournalEntry({
        pluginId: "codex",
        cursorOptions: { namespace: "cursors", maxEntries: 1 },
        cursorKey: "turns",
        journalOptions: { namespace: "journal", maxEntries: 1 },
        journalKeyPrefix: "event-",
        journalKeyRange: { keyStartInclusive: "event-", keyEndExclusive: "event." },
        journalValue: { completed: true },
      }),
    ).toBe(1);
    expect(getPluginStateCapacity("codex").liveEntries).toBe(50_009);

    for (const [index, count] of [20_000, 20_000, 10_000].entries()) {
      const catalog = createPluginStateKeyedStore<number>("codex", {
        namespace: `catalog-${index}`,
        maxEntries: 20_000,
      });
      expect(await catalog.count!()).toBe(count);
      expect(await catalog.lookup(`thread-${index * 20_000}`)).toBe(index * 20_000);
    }
  });
});
