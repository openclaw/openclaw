import { afterEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginBlobStore, resetPluginBlobStoreForTests } from "./plugin-blob-store.js";

afterEach(() => {
  resetPluginBlobStoreForTests();
});

describe("plugin blob store", () => {
  it("deletes and clears entries through SQLite state", async () => {
    await withOpenClawTestState({ label: "plugin-blob-store" }, async () => {
      const store = createPluginBlobStore<{ contentType: string }>("zalo", {
        namespace: "media",
        maxEntries: 10,
      });

      await store.register("one", { contentType: "image/png" }, Buffer.from("one"));
      await store.register("two", { contentType: "image/jpeg" }, Buffer.from("two"));

      await expect(store.delete("one")).resolves.toBe(true);
      await expect(store.lookup("one")).resolves.toBeUndefined();
      await expect(store.entries()).resolves.toMatchObject([
        {
          key: "two",
          metadata: { contentType: "image/jpeg" },
        },
      ]);

      await store.clear();
      await expect(store.entries()).resolves.toEqual([]);
    });
  });
});
