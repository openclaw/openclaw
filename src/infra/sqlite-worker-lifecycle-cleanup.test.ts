import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));
afterEach(() => vi.restoreAllMocks());

it("preserves a native commit and its queued follower when admission cleanup fails", async () => {
  const root = dirs.make("sqlite-worker-admission-cleanup-");
  const databasePath = path.join(root, "store.sqlite");
  const gatePath = path.join(root, "release");
  await writeFile(gatePath, "preparation already released");
  const broker = new SqliteWorkerBroker();
  const cleanupFailure = new Error("Synthetic post-grant cleanup failed");
  const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  try {
    const store = await broker.open<FixtureOperations>({
      moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
      databasePath,
      input: { type: "prepare", markerPath: path.join(root, "prepared"), gatePath, guarded: true },
    });
    assert.ok(store);
    const write = broker.runOperation(
      store,
      (scope) => scope.execute({ type: "append", input: { value: "committed once" } }),
      undefined,
      undefined,
      () => ({
        nativeLocations: [databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          grant();
          if (request.stage === "commit") {
            throw cleanupFailure;
          }
        }),
      }),
    );
    const follower = store.execute({ type: "read", input: undefined });
    const [receipt, values] = await Promise.all([write, follower]);
    expect(receipt).toMatchObject({ writes: 1 });
    expect(values).toEqual(["committed once"]);
    expect(warnings).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ errors: [cleanupFailure] }),
    );
    await store.close();
    const reopened = await broker.open<FixtureOperations>({
      moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
      databasePath,
      input: undefined,
    });
    assert.ok(reopened);
    expect(await reopened.execute({ type: "read", input: undefined })).toEqual(["committed once"]);
  } finally {
    await broker.close();
  }
});
