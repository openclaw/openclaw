import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "./errno.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { sqliteDatabaseAdmissionState as state } from "./sqlite-database-admission-context.js";
import {
  prepareSqliteDatabaseAdmissionAsync,
  prepareSqliteDatabaseAdmissionForPath,
  publishSqliteDatabaseAdmission,
  retireSqliteDatabaseAdmissionForPath,
} from "./sqlite-database-admission.js";
import { isSqliteDescriptorCustodyClosed } from "./sqlite-descriptor-custody.js";
import { holdReadFileCallback } from "./sqlite-worker-fixture.test-support.js";
import { assertDatabaseFileIdentity, type DatabaseFileIdentity } from "./sqlite-worker-identity.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it("lets a raw worker's first snapshot retire a descriptor adopted after it started", async ({
  signal,
}) => {
  const location = path.join(directories.make("sqlite-raw-custody-"), "database.sqlite");
  new DatabaseSync(location).close();
  using acquisition = holdReadFileCallback(location);
  const prepared = prepareSqliteDatabaseAdmissionAsync({ location, assertCurrent() {} });
  const outcome = Promise.allSettled([prepared]);
  // Register cleanup before setup can fail, with only the resources acquired so far.
  await using fixture: {
    sibling?: DatabaseSync;
    worker?: Worker;
    joined?: Promise<PromiseSettledResult<unknown[]>[]>;
    physical?: DatabaseFileIdentity;
    [Symbol.asyncDispose](): Promise<void>;
  } = {
    async [Symbol.asyncDispose]() {
      acquisition.release();
      await outcome;
      if (fixture.worker && fixture.worker.threadId !== -1) {
        await fixture.worker.terminate();
      }
      await fixture.joined;
      if (fixture.sibling?.isOpen) {
        fixture.sibling.close();
      }
      retireSqliteDatabaseAdmissionForPath(location);
      // A broken baseline can leave this exact acquired fd orphaned after all native users joined.
      if (fixture.physical && acquisition.descriptor !== undefined) {
        let live = false;
        try {
          assertDatabaseFileIdentity(
            fs.fstatSync(acquisition.descriptor, { bigint: true }),
            fixture.physical,
          );
          live = true;
        } catch (error) {
          if (!hasErrnoCode(error, "EBADF")) {
            throw error;
          }
        }
        if (live) {
          fs.closeSync(acquisition.descriptor);
        }
      }
    },
  };
  await withinTest(
    awaitGateBeforeSettlement(
      acquisition.entered,
      prepared,
      "Read did not reach its real open callback",
    ),
    signal,
  );
  const sibling = (fixture.sibling = openNodeSqliteDatabase(location));
  const fact = { name: "raw-worker-custody-proof" };
  publishSqliteDatabaseAdmission(sibling, fact, 42);
  const record = state.registry.forLocation(location);
  assert(record && acquisition.descriptor !== undefined);
  fixture.physical = record.physicalIdentity;
  const read = prepareSqliteDatabaseAdmissionForPath(location, fact);
  expect(read()).toBe(42);
  expect(record.descriptor).not.toBe(acquisition.descriptor);
  const worker = (fixture.worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      (async () => {
        const { register } = await import(workerData.loader);
        const unregister = register();
        const { retireSqliteDatabaseAdmissionForPath } = await import(workerData.admission);
        const { sqliteDatabaseAdmissionState } = await import(workerData.context);
        const record = sqliteDatabaseAdmissionState.registry.forLocation(workerData.location);
        if (!record) throw new Error("Initial raw worker admission missing");
        parentPort.once("message", () => {
          retireSqliteDatabaseAdmissionForPath(workerData.location);
          unregister();
          parentPort.close();
        });
        parentPort.postMessage({ descriptor: record.descriptor, custody: record.descriptorCustody.id });
      })().catch((error) => { throw error; });
    `,
    {
      eval: true,
      execArgv: [],
      workerData: {
        location,
        loader: import.meta.resolve("tsx/esm/api"),
        admission: new URL("./sqlite-database-admission.ts", import.meta.url).href,
        context: new URL("./sqlite-database-admission-context.ts", import.meta.url).href,
      },
    },
  ));
  const exited = once(worker, "exit");
  fixture.joined = Promise.allSettled([exited]);
  expect((await withinTest(once(worker, "message"), signal))[0]).toEqual({
    descriptor: record.descriptor,
    custody: record.descriptorCustody.id,
  });
  acquisition.release();
  await withinTest(prepared, signal);
  expect(state.registry.forLocation(location)).toBe(record);
  expect(fs.fstatSync(record.descriptor).isFile()).toBe(true);
  expect(fs.fstatSync(acquisition.descriptor).isFile()).toBe(true);
  sibling.close();
  expect(state.registry.records.has(record.identity)).toBe(false);
  expect(state.registry.descriptors.has(record.identity)).toBe(true);
  worker.postMessage("retire", []);
  expect(await withinTest(exited, signal)).toEqual([0]);
  expect(isSqliteDescriptorCustodyClosed(record.descriptorCustody)).toBe(true);
  expect(read()).toBeUndefined();
  for (const descriptor of [record.descriptor, acquisition.descriptor]) {
    expect(() => fs.fstatSync(descriptor)).toThrow(expect.objectContaining({ code: "EBADF" }));
  }
  state.registry.publish();
  expect(state.registry.descriptors.has(record.identity)).toBe(false);
});
