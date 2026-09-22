import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createPluginBlobStoreForTests,
  resetPluginBlobStoreForTests,
} from "./plugin-blob-store.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginBlobStoreForTests();
});

it("fetches only the eviction prefix needed for a bounded blob write", async () => {
  await withOpenClawTestState({ label: "blob-eviction-prefix" }, async (state) => {
    const store = createPluginBlobStoreForTests(
      "diffs",
      {
        namespace: "artifacts",
        maxEntries: 64,
        maxBytesPerEntry: 16,
        maxBytesPerNamespace: 1024,
      },
      state.env,
    );
    const { db } = openOpenClawStateDatabase({ env: state.env });
    const insert = db.prepare(`INSERT INTO plugin_blob_entries
      (plugin_id, namespace, entry_key, metadata_json, blob, created_at, expires_at)
      VALUES ('diffs', 'artifacts', ?, '{}', ?, ?, NULL)`);
    for (let index = 0; index < 64; index += 1) {
      insert.run(`old-${index}`, new Uint8Array([index]), index);
    }
    let fetchedRows = 0;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoke with the original native receiver.
    const iterate = StatementSync.prototype.iterate;
    const reads = vi.spyOn(StatementSync.prototype, "iterate").mockImplementation(function (
      this: StatementSync,
      ...args
    ) {
      const iterator = iterate.apply(this, args);
      const next = iterator.next.bind(iterator);
      vi.spyOn(iterator, "next").mockImplementation((...input) => {
        const result = next(...input);
        if (!result.done) {
          fetchedRows += 1;
        }
        return result;
      });
      return iterator;
    });
    await store.register("new", new Uint8Array([255]), { retained: true });
    reads.mockRestore();
    expect(fetchedRows).toBeLessThanOrEqual(2);
    await expect(store.lookup("old-0")).resolves.toBeUndefined();
    await expect(store.lookup("old-1")).resolves.toMatchObject({ bytes: new Uint8Array([1]) });
    await expect(store.lookup("new")).resolves.toMatchObject({ metadata: { retained: true } });
    expect(await store.entries()).toHaveLength(64);
    await store.clear();
    expect(await store.entries()).toEqual([]);
  });
});
