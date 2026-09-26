import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  useSqliteWorkerStoreFixture,
  appendWorkerRow as append,
  readWorkerRows as read,
} from "./sqlite-worker-fixture.test-support.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import {
  closeUnclaimedSharedStateSqliteWorkers,
  hasUnclaimedSharedStateSqliteCleanup,
  openAgentDatabaseSqliteWorkerStore,
} from "./sqlite-worker-store.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 32,
}));

const { stores, databasePath, open } = useSqliteWorkerStoreFixture(
  "openclaw-sqlite-worker-open-refusal-",
);

it.skipIf(Boolean(process.versions.bun))(
  "refuses before native factory entry without retiring pooled siblings or blocking recovery",
  async () => {
    const file = databasePath();
    const root = path.dirname(file);
    const seeded = await open(file);
    await seeded.close();
    const siblings = [];
    for (let index = 0; index < 4; index++) {
      const store = await open(databasePath());
      siblings.push({ store, receipt: await append(store, "before refusal") });
    }
    const refused = new Error("Fixture opening authority revoked");
    let allowed = false;
    const markerPath = path.join(root, "factory-entered");
    const reopen = async () => {
      const store = await openAgentDatabaseSqliteWorkerStore<FixtureOperations>(
        {
          moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
          databasePath: file,
          existingOnly: true,
          input: { type: "observe", markerPath },
        },
        {
          stateContext: {
            environment: { OPENCLAW_STATE_DIR: root },
          },
          assertCurrent() {},
          createAdmission: () => ({
            nativeLocations: [file],
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              expect(request).toEqual({ stage: "open", facts: { type: "observe", markerPath } });
              if (!allowed) {
                throw refused;
              }
              grant();
            }),
          }),
        },
      );
      if (store) {
        stores.add(store);
      }
      return store;
    };
    const requests = vi.spyOn(Worker.prototype, "postMessage");
    try {
      await expect(reopen()).rejects.toBe(refused);
      const opening = requests.mock.calls.findIndex(
        ([request]) => request.type === "open" && request.databasePath === file,
      );
      const targetWorker = requests.mock.contexts[opening];
      assert(targetWorker instanceof Worker, "Expected the refused request's native Worker");
      expect(siblings.map(({ receipt }) => receipt.threadId)).toContain(targetWorker.threadId);
      await expect(readFile(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(hasUnclaimedSharedStateSqliteCleanup(file)).toBe(false);
      await closeUnclaimedSharedStateSqliteWorkers(file);
      allowed = true;
      const recovered = await reopen();
      expect(recovered).toBeDefined();
      expect(await readFile(markerPath, "utf8")).toBe("factory called");
      await recovered?.close();
      for (const { store, receipt } of siblings) {
        expect(await append(store, "after cleanup")).toEqual({ ...receipt, writes: 2 });
        expect(await read(store)).toEqual(["before refusal", "after cleanup"]);
      }
    } finally {
      requests.mockRestore();
      await drainGlobalSingletonLifecycleState();
    }
  },
);
