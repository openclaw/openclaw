import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { AsyncPreparedSqliteReadOnlyLocation } from "../infra/sqlite-readonly-location.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { expectCalls, makeReadSource, settle } from "./openclaw-state-db-fixtures.test-support.js";
import {
  createReadWorkerFixture,
  observeAsyncFixture,
  retainFixturePreparation,
} from "./openclaw-state-db-readonly.test-support.js";
import type { OpenClawStateReadOutcome } from "./openclaw-state-read.types.js";

vi.hoisted(() => {
  // Shared setup can preload the real reader; bind this fixture to its transport mocks.
  vi.resetModules();
});

const mock = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  read: vi.fn<Parameters<typeof createReadWorkerFixture>[0]>(),
  cleanup: vi.fn<() => Promise<boolean>>(),
  borrow: vi.fn(),
  independent: vi.fn(),
  prepareNative: vi.fn(),
  prepareSource: vi.fn(),
  prepareSourceAsync: vi.fn(),
  closePreparation: vi.fn<() => void>(),
  constructTransport: vi.fn<() => void>(),
}));

vi.mock("./openclaw-state-db-cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-db-cache.js")>()),
  borrowOpenClawStateDatabaseForAsyncRead: mock.borrow,
  retainOpenClawStateDatabaseForIndependentRead: mock.independent,
}));
vi.mock("../infra/sqlite-readonly-location.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-readonly-location.js")>()),
  prepareSqliteReadOnlyLocationFromOwnedDatabase: mock.prepareNative,
}));
let finishProducer: (() => void) | undefined;
// mock-isolation: Exercise read cleanup with a controlled transport instead of native workers.
vi.mock("./openclaw-state-read-worker.js", () => {
  const fixture = createReadWorkerFixture(mock.read, mock.close);
  return {
    captureOpenClawStateReadSource() {
      const capturedSource = fixture.captureOpenClawStateReadSource();
      return {
        ...capturedSource,
        createTransport() {
          mock.constructTransport();
          return capturedSource.createTransport();
        },
      };
    },
  };
});
vi.mock("../infra/sqlite-snapshot-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-snapshot-source.js")>()),
  prepareSqliteReadOnlyLocation: mock.prepareSource,
  startSqliteReadOnlyLocationAsync: (
    ...args: Parameters<
      typeof import("../infra/sqlite-snapshot-source.js").startSqliteReadOnlyLocationAsync
    >
  ) => {
    const retained = retainFixturePreparation(
      observeAsyncFixture(async () => {
        const prepared: AsyncPreparedSqliteReadOnlyLocation = await mock.prepareSourceAsync(
          ...args,
        );
        return {
          ...prepared,
          startCleanup: () => observeAsyncFixture(() => prepared.cleanupAsync()),
        };
      }),
    );
    return {
      ...retained,
      startClose() {
        mock.closePreparation();
        return retained.startClose();
      },
    };
  },
}));
vi.mock("../infra/sqlite-readonly-location-cleanup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-readonly-location-cleanup.js")>()),
  // Preparation is mocked; this fixture has no private directory to retain.
  retainSnapshotTempDirectory: () => () => {},
}));

import {
  createOpenClawDatabaseMaintenanceScope as createMaintenance,
  isStateDatabaseReadAdmissionInvalidatedError,
} from "./openclaw-state-db-async-lifecycle.js";
import {
  captureOpenClawStateDatabaseReadAdmission as captureReadAdmission,
  clearOpenClawStateDatabaseOpenFailure,
  closeOpenClawStateDatabaseByPathAsync as closePath,
} from "./openclaw-state-db-cache.js";
import {
  executeExistingOpenClawStateRead as readExisting,
  withArtifactPreservingStateReads as preserveArtifacts,
  withOpenClawStateDatabaseReadSnapshot as withSnapshot,
} from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync as closeState,
  closeOpenClawStateDatabaseForTest as resetState,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    finishProducer?.();
    finishProducer = undefined;
    mock.close.mockReset().mockResolvedValue();
    mock.cleanup.mockReset().mockResolvedValue(true);
    await closeState();
    resetState();
    cleanup();
  }),
);

function preparedLocation() {
  return { location: "/fixture/prepared.sqlite", cleanupAsync: mock.cleanup };
}

let options: ReturnType<typeof makeReadSource>;
beforeEach(() => {
  options = makeReadSource(tempDirs, "openclaw-read-cleanup-owner-");
  mock.constructTransport.mockReset();
  mock.closePreparation.mockReset();
  mock.borrow.mockReset();
  mock.independent.mockReset();
  mock.prepareNative.mockReset().mockImplementation(async () => preparedLocation());
  mock.prepareSource.mockReset().mockImplementation(async () => ({
    ...preparedLocation(),
    cleanupRoot: "/fixture/prepared",
    cleanup: () => true,
  }));
  mock.prepareSourceAsync.mockReset().mockImplementation(async () => ({
    ...preparedLocation(),
    cleanupRoot: "/fixture/prepared",
  }));
  mock.close.mockReset().mockResolvedValue();
  mock.cleanup.mockReset().mockResolvedValue(true);
  mock.read.mockReset().mockResolvedValue({
    value: { ok: true, type: "backup.runs", sourceAdmitted: true, runs: [] },
  });
});

function read() {
  return readExisting(options, { type: "backup.runs" });
}

function startPendingRead() {
  const started = createDeferredCore();
  const result = createDeferredCore<OpenClawStateReadOutcome>();
  const finish = () =>
    result.resolve({ value: { ok: true, type: "backup.runs", sourceAdmitted: true, runs: [] } });
  finishProducer = finish;
  mock.read.mockImplementation(() => {
    started.resolve();
    return result.promise;
  });
  return { started, finish };
}

it("closes pending snapshot preparation before joining the read at shutdown", async () => {
  const started = createDeferredCore();
  const preparation = createDeferredCore<AsyncPreparedSqliteReadOnlyLocation>();
  const failure = new Error("snapshot preparation closed");
  mock.prepareSourceAsync.mockImplementation(() => {
    started.resolve();
    return preparation.promise;
  });
  mock.closePreparation.mockImplementation(() => preparation.reject(failure));
  finishProducer = () => preparation.reject(failure);
  const result = preserveArtifacts(read).catch((error: unknown) => error);
  await started.promise;
  await closePath(options.path);
  expect(await result).toBe(failure);
  expect(mock.read).not.toHaveBeenCalled();
});

it("releases read ownership when transport construction fails", async () => {
  const failure = new Error("transport construction failed");
  mock.constructTransport.mockImplementation(() => {
    throw failure;
  });
  await expect(withSnapshot(read, options)).rejects.toBe(failure);
  expect(mock.cleanup).toHaveBeenCalledOnce();
  await closePath(options.path);
});

it("retains the borrowed source through pending preparation and failed published cleanup", async () => {
  const started = createDeferredCore();
  const prepared = createDeferredCore<ReturnType<typeof preparedLocation>>();
  const release = vi.fn();
  mock.borrow.mockReturnValue({ database: { db: {} }, assertCurrent() {}, observe() {}, release });
  mock.prepareNative.mockImplementation(async () => {
    started.resolve();
    return prepared.promise;
  });
  mock.cleanup.mockResolvedValueOnce(false).mockResolvedValue(true);
  finishProducer = () => prepared.resolve(preparedLocation());
  const result = preserveArtifacts(read).catch((error: unknown) => error);
  await started.promise;
  const closing = closePath(options.path).catch((error: unknown) => error);
  expectCalls(0, release, mock.read);
  finishProducer();
  expect(await closing).toMatchObject({
    message: expect.stringMatching(/snapshot cleanup failed/),
  });
  expect(await result).toBeInstanceOf(Error);
  expectCalls(0, mock.read, release);
  await closePath(options.path);
  expect(mock.cleanup).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledOnce();
});

it.each(["failure", "success"] as const)(
  "preserves read errors and checks successful reads before returning data (%s)",
  async (outcome) => {
    const readFailure = new Error("worker query failed");
    const observationFailure = new Error("native read owner retired");
    const release = vi.fn();
    mock.independent.mockReturnValue({
      database: { db: {} },
      assertCurrent() {},
      observe() {
        throw observationFailure;
      },
      release,
    });
    if (outcome === "failure") {
      mock.read.mockResolvedValue({ error: readFailure, sourceAdmitted: true });
    }
    await expect(read()).rejects.toBe(outcome === "failure" ? readFailure : observationFailure);
    expect(release).toHaveBeenCalledOnce();
  },
);

it("retains ordered cleanup for canonical retry after a read failure", async () => {
  const readFailure = new Error("read failed");
  const stopFailure = new Error("transport stop not acknowledged");
  mock.read.mockRejectedValue(readFailure);
  mock.close.mockRejectedValueOnce(stopFailure);
  mock.cleanup.mockResolvedValueOnce(false).mockResolvedValue(true);

  await expect(preserveArtifacts(read)).rejects.toMatchObject({
    cause: readFailure,
    errors: [readFailure, stopFailure],
  });
  expect(mock.cleanup).not.toHaveBeenCalled();
  await expect(closePath(options.path)).rejects.toThrow("snapshot cleanup failed");
  expect(mock.close).toHaveBeenCalledTimes(2);
  // Failed drainage leaves the database live, so reads resume until the retry seals again.
  captureReadAdmission(options.path).assertCurrent();
  await expect(closePath(options.path)).resolves.toBe(false);
  expectCalls(2, mock.close, mock.cleanup);
  expect(() => captureReadAdmission(options.path).assertCurrent()).not.toThrow();
});

it("retains an outer snapshot until its child transport acknowledges cleanup", async () => {
  const failure = new Error("child stop not acknowledged");
  mock.close.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure).mockResolvedValue();
  await expect(withSnapshot(read, options)).rejects.toMatchObject({
    cause: failure,
  });
  expect(mock.cleanup).not.toHaveBeenCalled();
  await expect(closePath(options.path)).resolves.toBe(false);
  expect(mock.close).toHaveBeenCalledTimes(3);
  expect(mock.cleanup).toHaveBeenCalledTimes(1);
});

it("keeps a composite snapshot alive when its callback closes the live writer", async () => {
  await withSnapshot(async () => {
    await closePath(options.path);
    expect(mock.cleanup).not.toHaveBeenCalled();
    expect(await read()).toEqual({
      ok: true,
      type: "backup.runs",
      sourceAdmitted: true,
      runs: [],
    });
  }, options);
  expect(mock.cleanup).toHaveBeenCalledTimes(1);
});

it("retries transport stop and settles the already-selected query", async () => {
  const { started, finish } = startPendingRead();
  const failure = new Error("first stop not acknowledged");
  mock.close.mockRejectedValueOnce(failure).mockImplementation(async () => finish());
  const observed = settle(preserveArtifacts(read));
  await started.promise;
  await expect(closePath(options.path)).rejects.toBe(failure);
  expect(mock.closePreparation).not.toHaveBeenCalled();
  expect(mock.cleanup).not.toHaveBeenCalled();
  await expect(closePath(options.path)).resolves.toBe(false);
  expect(mock.close).toHaveBeenCalledTimes(2);
  expect(mock.cleanup).toHaveBeenCalledTimes(1);
  expect(mock.closePreparation).toHaveBeenCalledOnce();
  expect(await observed).toEqual({
    value: { ok: true, type: "backup.runs", sourceAdmitted: true, runs: [] },
  });
});

it("rejects a settled read whose database admission was cleared before delivery", async () => {
  const { started, finish } = startPendingRead();
  const observed = settle(preserveArtifacts(read));
  await started.promise;
  clearOpenClawStateDatabaseOpenFailure(options.path);
  finish();
  const result = await observed;
  expect("error" in result && isStateDatabaseReadAdmissionInvalidatedError(result.error)).toBe(
    true,
  );
  expect(mock.cleanup).toHaveBeenCalledOnce();
});

it("joins maintenance reads and retries their transport before closing scoped handles", async () => {
  const scope = createMaintenance();
  const { started, finish } = startPendingRead();
  const events: string[] = [];
  const failure = new Error("transport stop not acknowledged");
  mock.close
    .mockRejectedValueOnce(failure)
    .mockRejectedValueOnce(failure)
    .mockImplementation(async () => {
      events.push("transport stopped");
    });
  scope.own({}, "shared-handles", () => {
    events.push("handle closed");
  });
  const operation = scope.run(read);
  const assertion = expect(operation).rejects.toBe(failure);
  await started.promise;
  const closing = scope.close();
  const closeAssertion = expect(closing).rejects.toBe(failure);
  expect(events).toEqual([]);
  finish();
  await assertion;
  await closeAssertion;
  expect(events).toEqual([]);
  await scope.close();
  expect(events).toEqual(["transport stopped", "handle closed"]);
});
