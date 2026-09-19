import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireStateDatabaseHandleExclusion } from "../infra/state-database-coordinator.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";

type MockPool = {
  selectLibrary: ReturnType<typeof vi.fn<() => void>>;
  run: ReturnType<
    typeof vi.fn<(request: OpenClawStateReadRequest) => Promise<OpenClawStateReadReply>>
  >;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  notify?: (error: unknown) => void | Promise<void>;
};
const mock = vi.hoisted((): MockPool => ({
  run: vi.fn(),
  close: vi.fn(),
  selectLibrary: vi.fn<() => void>(),
}));
vi.mock("../infra/bun-sqlite-library.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/bun-sqlite-library.js")>();
  return {
    ...actual,
    ensureSqliteLibrarySelected() {
      const selection = actual.ensureSqliteLibrarySelected();
      mock.selectLibrary();
      return selection;
    },
  };
});
vi.mock("../infra/worker-task-pool.js", () => ({
  WorkerTaskPool: class {
    constructor(options: { onRetirementFailure?: MockPool["notify"] }) {
      expect(mock.selectLibrary).toHaveBeenCalledOnce();
      mock.notify = options.onRetirementFailure;
    }
    run = mock.run;
    close = mock.close;
  },
}));

import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { withOpenClawStateSettlementRead } from "./openclaw-state-settlement-read.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { selectProfileDisplayEntries } from "./user-profiles-internal.js";
import { ensureProfileForEmail } from "./user-profiles.js";

beforeEach(() => mock.selectLibrary.mockClear());

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    mock.close.mockResolvedValue();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

it.each([false, true])(
  "preserves interrupted settlement task errors and source custody through canonical retry (close retry fails=%s)",
  async (retryFails) => {
    mock.run.mockReset();
    mock.close.mockReset();
    const root = tempDirs.make("openclaw-settlement-task-failure-");
    const pathname = path.join(root, "source.sqlite");
    const options = { path: pathname, env: { OPENCLAW_STATE_DIR: root } };
    const profile = ensureProfileForEmail("settlement@example.test", options);
    const descriptor = selectProfileDisplayEntries(openOpenClawStateDatabase(options).db, [
      profile.id,
    ])[0]![1];
    await closeOpenClawStateDatabaseAsync();
    const context = captureOpenClawStateWorkerContext(options);
    const command = { type: "userProfiles.reconcile", profileId: profile.id } as const;
    const reply: OpenClawStateReadReply = {
      ok: true,
      type: command.type,
      sourceAdmitted: true,
      profile: descriptor,
    };
    const started = createDeferredCore();
    const closeAttempt = createDeferredCore();
    const task = createDeferredCore<OpenClawStateReadReply>();
    const retryCloseStarted = createDeferredCore();
    const stopped = createDeferredCore();
    const delivery = new Error("mutation result delivery failed");
    const query = new Error("interrupted settlement task failed");
    const retirement = new Error("first settlement worker stop failed");
    const retryFailure = new Error("settlement close retry failed");
    const mutation = vi.fn();
    const publish = vi.fn(() => true);
    const release = vi.fn();
    mock.run.mockImplementationOnce(() => {
      started.resolve();
      return task.promise;
    });
    mock.close.mockImplementationOnce(async () => {
      closeAttempt.resolve();
      if (retryFails) {
        throw retryFailure;
      }
    });
    try {
      const result = withOpenClawStateSettlementRead(context, async (read) => {
        mutation();
        read.bind(command, Promise.resolve({ kind: "completed" }), {
          publishCommitted: publish,
          prepareRecoveryRead: async () => ({ publish }),
          release,
        });
        mock.selectLibrary.mockClear();
        throw delivery;
      }).catch((error: unknown) => error);
      await started.promise;
      await mock.notify?.(retirement);
      // The retirement signal wins the transport race before the task's own rejection.
      await closeAttempt.promise;
      task.reject(query);
      const failure = await result;
      expect(publish).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(mock.close).toHaveBeenCalledTimes(1);
      expect(() =>
        acquireStateDatabaseHandleExclusion({ databasePath: pathname, busyTimeoutMs: 0 }),
      ).toThrow();

      mock.selectLibrary.mockClear();
      mock.run.mockResolvedValue(reply);
      if (retryFails) {
        mock.close.mockResolvedValueOnce();
      }
      mock.close.mockImplementationOnce(() => {
        retryCloseStarted.resolve();
        return stopped.promise;
      });
      const closing = closeOpenClawStateDatabaseAsync();
      try {
        await retryCloseStarted.promise;
        expect(publish).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
      } finally {
        stopped.resolve();
        await closing;
      }
      expect(publish).toHaveBeenCalledExactlyOnceWith(descriptor);
      expect(release).toHaveBeenCalledOnce();
      expect(mutation).toHaveBeenCalledOnce();
      expect(mock.run.mock.calls.map(([request]) => request.command)).toEqual([command, command]);
      for (const [request] of mock.run.mock.calls) {
        expect(request).toMatchObject({
          databasePath: pathname,
          location: pathname,
          expectedIdentity: context.admission.identity.key,
          checkFreshAdmission: false,
        });
      }
      expect(mock.close).toHaveBeenCalledTimes(retryFails ? 3 : 2);
      const exclusion = acquireStateDatabaseHandleExclusion({ databasePath: pathname });
      exclusion.release();
      expect(failure).toMatchObject({
        errors: [
          delivery,
          expect.objectContaining({
            errors: [query, retirement, ...(retryFails ? [retryFailure] : [])],
          }),
        ],
      });
    } finally {
      task.resolve(reply);
      stopped.resolve();
      mock.selectLibrary.mockClear();
      mock.run.mockResolvedValue(reply);
      mock.close.mockReset().mockResolvedValue();
      await closeOpenClawStateDatabaseAsync();
    }
  },
);

it.each([false, true])(
  "preserves the raw task failure when retirement fails before acknowledging stop (retry fails=%s)",
  async (retryFails) => {
    mock.run.mockReset();
    mock.close.mockReset();
    const root = tempDirs.make("openclaw-read-task-failure-");
    const pathname = path.join(root, "source.sqlite");
    // Only filesystem identity is consulted; the worker pool is entirely mocked.
    fs.writeFileSync(pathname, "mock worker source");
    const started = createDeferredCore();
    const task = createDeferredCore<OpenClawStateReadReply>();
    const original = new Error("original worker task failed");
    const retirement = new Error("first worker stop failed");
    const retryFailure = new Error("second worker stop failed");
    mock.run.mockImplementation(() => {
      started.resolve();
      return task.promise;
    });
    mock.close.mockResolvedValue();
    if (retryFails) {
      mock.close.mockRejectedValueOnce(retryFailure);
    }

    const result = executeExistingOpenClawStateRead(
      { path: pathname, env: { OPENCLAW_STATE_DIR: root } },
      { type: "fleet.list" },
    );
    const assertion = expect(result).rejects.toMatchObject({
      cause: original,
      errors: [original, retirement, ...(retryFails ? [retryFailure] : [])],
    });
    await started.promise;
    const notification = mock.notify?.(retirement);
    task.reject(original);
    await notification;
    await assertion;
    expect(mock.close).toHaveBeenCalledTimes(1);
    await closeOpenClawStateDatabaseAsync();
    expect(mock.close).toHaveBeenCalledTimes(retryFails ? 2 : 1);
    expect(mock.run).toHaveBeenCalledTimes(1);
  },
);

it("reads externally created state after an absent read without resetting admission", async () => {
  mock.run.mockReset();
  mock.close.mockReset().mockResolvedValue();
  const root = tempDirs.make("openclaw-read-first-creation-");
  const pathname = path.join(root, "source.sqlite");
  const options = { path: pathname, env: { OPENCLAW_STATE_DIR: root } };
  const command = { type: "fleet.list" } as const;
  expect(await executeExistingOpenClawStateRead(options, command)).toBeUndefined();
  expect(fs.existsSync(pathname)).toBe(false);
  expect(mock.run).not.toHaveBeenCalled();
  expect(mock.selectLibrary).not.toHaveBeenCalled();

  // Only file identity is real; creation does not publish a native cache handle.
  fs.writeFileSync(pathname, "mock worker source");
  const reply: OpenClawStateReadReply = {
    ok: true,
    type: "fleet.list",
    sourceAdmitted: true,
    cells: [],
  };
  mock.run.mockResolvedValue(reply);
  expect(await executeExistingOpenClawStateRead(options, command)).toEqual(reply);
  expect(mock.selectLibrary).toHaveBeenCalledOnce();
});
