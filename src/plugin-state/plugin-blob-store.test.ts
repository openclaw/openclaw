import { afterEach, describe, expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createPluginBlobStore,
  createPluginBlobSyncStore,
  resetPluginBlobStoreForTests,
} from "./plugin-blob-store.js";

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

  it("reads and consumes entries through the sync SQLite API", async () => {
    await withOpenClawTestState({ label: "plugin-blob-store-sync" }, async () => {
      const store = createPluginBlobSyncStore<{ contentType: string }>("memory-wiki", {
        namespace: "compiled-digest",
        maxEntries: 10,
      });

      store.register("agent-digest", { contentType: "application/json" }, Buffer.from("{}\n"));

      expect(store.lookup("agent-digest")).toMatchObject({
        key: "agent-digest",
        metadata: { contentType: "application/json" },
      });
      expect(store.consume("agent-digest")?.blob.toString("utf8")).toBe("{}\n");
      expect(store.lookup("agent-digest")).toBeUndefined();
    });
  });
});
