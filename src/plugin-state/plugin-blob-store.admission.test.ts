import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { reserveSqliteWorkerInputPreparation } from "../infra/sqlite-worker-store.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import {
  createPluginBlobStoreForTests,
  resetPluginBlobStoreForTests,
} from "./plugin-blob-store.js";

describe("plugin-blob-store.admission", () => {
  const dirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      try {
        await closeOpenClawStateDatabaseAsync();
        resetPluginBlobStoreForTests();
      } finally {
        cleanup();
      }
    }),
  );
  const MIB = 1024 * 1024;
  function fixture() {
    const env = { ...process.env, OPENCLAW_STATE_DIR: dirs.make("blob-input-preparation-") };
    const store = createPluginBlobStoreForTests(
      "blob-admission",
      {
        namespace: "prepared",
        maxEntries: 1,
        maxBytesPerEntry: 100 * MIB,
        maxBytesPerNamespace: 100 * MIB,
      },
      env,
    );
    return { env, store };
  }

  it("register bounds copied payloads before awaiting worker preparation", async () => {
    const { store } = fixture();
    const concurrentInputs = Array.from({ length: 3 }, () =>
      reserveSqliteWorkerInputPreparation(64 * MIB),
    );
    const bytes = new Uint8Array(16 * MIB).fill(7);
    const pending = Array.from({ length: 3 }, () =>
      store.register("same-key", bytes, { version: 1 }),
    );
    const refused = store.register("same-key", bytes, { version: 1 });
    void refused.catch(() => undefined);
    try {
      expect(() => {
        const extra = reserveSqliteWorkerInputPreparation(16 * MIB);
        extra.release();
      }).toThrow(expect.objectContaining({ code: "overloaded" }));
      bytes.fill(9);
      await expect(refused).rejects.toMatchObject({
        code: "PLUGIN_BLOB_OPEN_FAILED",
        cause: { code: "overloaded" },
      });
      await Promise.all(pending);
      const entry = await store.lookup("same-key");
      expect(entry?.bytes.byteLength).toBe(16 * MIB);
      expect(entry?.bytes[0]).toBe(7);
      expect(entry?.bytes.at(-1)).toBe(7);
      expect(entry?.metadata).toEqual({ version: 1 });
      const recovered = reserveSqliteWorkerInputPreparation(64 * MIB);
      recovered.release();
    } finally {
      for (const preparation of concurrentInputs) {
        preparation.release();
      }
      await Promise.allSettled([...pending, refused]);
    }
  });

  it("releases captured capacity after copying fails", async () => {
    const { store } = fixture();
    const concurrentInputs = Array.from({ length: 3 }, () =>
      reserveSqliteWorkerInputPreparation(64 * MIB),
    );
    const bytes = new Uint8Array(16 * MIB);
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    try {
      await expect(store.register("failed", bytes, null)).rejects.toMatchObject({
        code: "PLUGIN_BLOB_OPEN_FAILED",
      });
      const recovered = reserveSqliteWorkerInputPreparation(64 * MIB);
      recovered.release();
    } finally {
      for (const preparation of concurrentInputs) {
        preparation.release();
      }
    }
  });
});
