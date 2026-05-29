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

  it("deletes expired entries for the current namespace", async () => {
    await withOpenClawTestState({ label: "plugin-blob-store-expired" }, async () => {
      const store = createPluginBlobStore<{ contentType: string }>("zalo", {
        namespace: "media",
        maxEntries: 10,
      });
      const otherNamespace = createPluginBlobStore<{ contentType: string }>("zalo", {
        namespace: "other-media",
        maxEntries: 10,
      });

      await store.register("live", { contentType: "image/jpeg" }, Buffer.from("live"));
      await store.register("expired", { contentType: "image/png" }, Buffer.from("expired"), {
        ttlMs: 1,
      });
      await otherNamespace.register("expired", { contentType: "image/gif" }, Buffer.from("other"), {
        ttlMs: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));

      await expect(store.deleteExpired()).resolves.toBe(1);
      await expect(store.entries()).resolves.toMatchObject([
        {
          key: "live",
          metadata: { contentType: "image/jpeg" },
        },
      ]);
      await expect(otherNamespace.deleteExpired()).resolves.toBe(1);
    });
  });

  it("rejects metadata that cannot round-trip as JSON", async () => {
    await withOpenClawTestState({ label: "plugin-blob-store-json-metadata" }, async () => {
      const store = createPluginBlobStore<unknown>("zalo", {
        namespace: "media",
        maxEntries: 10,
      });

      await expect(
        store.register("undefined-field", { value: undefined }, Buffer.from("blob")),
      ).rejects.toThrow("plugin blob metadata at metadata.value must be JSON-serializable");
      await expect(
        store.register("function-field", { callback() {} }, Buffer.from("blob")),
      ).rejects.toThrow("plugin blob metadata at metadata.callback must be JSON-serializable");
      await expect(store.entries()).resolves.toEqual([]);
    });
  });
});
