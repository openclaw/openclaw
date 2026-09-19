import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import type {
  OpenClawStateReadAuthority,
  OpenClawStateReadLocation,
  OpenClawStateReadOutcome,
} from "./openclaw-state-read.types.js";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  assertCurrent: vi.fn<() => void>(),
  assertFresh: vi.fn<() => void>(),
  prepare: vi.fn(),
  cleanup: vi.fn<() => Promise<boolean>>(),
  read: vi.fn<
    (
      source: OpenClawStateReadLocation,
      authority: OpenClawStateReadAuthority,
    ) => Promise<OpenClawStateReadOutcome>
  >(),
  forbiddenNative: vi.fn(() => {
    throw new Error("Native reads must not be reached by rejected admission");
  }),
}));
vi.mock("./openclaw-state-db-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-db-cache.js")>();
  return {
    ...actual,
    captureOpenClawStateDatabaseReadAdmission: mocks.capture,
    registerOpenClawStateDatabaseAsyncResource: () => () => {},
    borrowOpenClawStateDatabaseForAsyncRead: () => undefined,
    retainOpenClawStateDatabaseForIndependentRead: () => undefined,
    openClawStateDatabaseCache: {
      ...actual.openClawStateDatabaseCache,
      getCachedOpenClawStateDatabase: () => undefined,
      assertOpenClawStateDatabaseOpenAllowed() {},
      assertOpenClawStateDatabaseFreshOpenAllowedAtPath: mocks.assertFresh,
    },
  };
});
vi.mock("../infra/sqlite-snapshot-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-snapshot-source.js")>()),
  prepareSqliteReadOnlyLocation: mocks.prepare,
  prepareSqliteReadOnlyLocationSync: mocks.forbiddenNative,
}));
vi.mock("../infra/sqlite-readonly-location-cleanup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-readonly-location-cleanup.js")>()),
  // Preparation is mocked; this fixture has no private directory to retain.
  retainSnapshotTempDirectory: () => () => {},
}));

vi.mock("./openclaw-state-db-read-connection.js", () => ({
  openOpenClawStateReadOnlyLocation: mocks.forbiddenNative,
  withOpenClawStateReadOnlyLocation: mocks.forbiddenNative,
}));
vi.mock("../infra/state-database-coordinator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/state-database-coordinator.js")>()),
  prepareStateDatabaseCanonicalMutation: () => undefined,
  hasStateDatabaseSourceExclusion: () => false,
}));
vi.mock("./openclaw-state-read-worker.js", () => ({
  createOpenClawStateReadTransport: () => ({
    read: mocks.read,
    validateFresh: async () => {},
    close: async () => {},
  }),
}));

import { isStateDatabaseReadAdmissionInvalidatedError } from "./openclaw-state-db-async-lifecycle.js";
import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshot,
  withDisposableOpenClawStateReads,
  withExistingOpenClawStateDatabaseCurrentReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";

beforeEach(() => {
  mocks.forbiddenNative.mockClear();
  mocks.read.mockReset().mockResolvedValue({
    value: { ok: true, type: "fleet.list", sourceAdmitted: true, cells: [] },
  });
  mocks.assertCurrent.mockReset();
  mocks.assertFresh.mockReset();
  mocks.cleanup.mockReset().mockResolvedValue(true);
  mocks.capture.mockReset().mockReturnValue({ identity: {}, assertCurrent: mocks.assertCurrent });
  mocks.prepare.mockReset().mockResolvedValue({
    location: "/fixture/private.sqlite",
    cleanupAsync: mocks.cleanup,
  });
});

it("retains discovery context when capturing read admission fails", async () => {
  await withTempDir("openclaw-discovery-admission-", async (root) => {
    const source = path.join(root, "source");
    fs.writeFileSync(source, "mock snapshot source; never opened as SQLite");
    const failure = new Error("synthetic admission refusal");
    mocks.capture.mockImplementation(() => {
      throw failure;
    });
    const operation = vi.fn(async () => 1);
    await expect(
      withOpenClawStateDatabaseReadSnapshot(operation, { path: source }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(`Cannot read shared state for discovery: ${source}`),
      cause: failure,
    });
    expect(operation).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});

it("preserves a precise source failure and cleans its prepared snapshot before callback admission", async () => {
  await withTempDir("openclaw-discovery-precedence-", async (root) => {
    const source = path.join(root, "source");
    fs.writeFileSync(source, "mock snapshot source; never opened as SQLite");
    const failure = new Error("synthetic readonly verification failure");
    mocks.prepare.mockImplementation(async () => {
      mocks.assertFresh.mockImplementation(() => {
        throw failure;
      });
      mocks.assertCurrent.mockImplementation(() => {
        throw new Error("read admission changed");
      });
      return { location: "/fixture/private.sqlite", cleanupAsync: mocks.cleanup };
    });
    const operation = vi.fn(async () => 1);
    await expect(withOpenClawStateDatabaseReadSnapshot(operation, { path: source })).rejects.toBe(
      failure,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });
});

// Escaped continuations retain ALS, but admission ends before private bytes are removed.
async function probeRetiredAdmission(source: string) {
  const options = { path: source };
  const attempts = {
    getter: () => getActiveOpenClawStateDatabaseReadSnapshot(options),
    native: () => withExistingOpenClawStateDatabaseReadOnly(() => "read", options),
    currentRows: () => withExistingOpenClawStateDatabaseCurrentReadOnly(() => "read", options),
    nestedSnapshot: () => withOpenClawStateDatabaseReadSnapshot(async () => "nested", options),
    nestedDisposable: () => withDisposableOpenClawStateReads(source, async () => "nested"),
    worker: () => executeExistingOpenClawStateRead(options, { type: "fleet.list" }),
  };
  return Object.fromEntries(
    await Promise.all(
      Object.entries(attempts).map(async ([name, run]) => {
        try {
          await Promise.resolve<unknown>(run());
          return [name, false];
        } catch (error) {
          return [name, isStateDatabaseReadAdmissionInvalidatedError(error)];
        }
      }),
    ),
  );
}

const rejectedAdmissions = {
  getter: true,
  native: true,
  currentRows: true,
  nestedSnapshot: true,
  nestedDisposable: true,
  worker: true,
};

it.each(["closing", "cleanup-failed", "closed"] as const)(
  "rejects escaped snapshot reads while %s instead of reopening a live source",
  async (phase) => {
    await withTempDir("openclaw-retired-snapshot-", async (root) => {
      const source = path.join(root, "source");
      fs.writeFileSync(source, "mock source; never opened as SQLite");
      const enteredCleanup = createDeferredCore();
      const finishCleanup = createDeferredCore<boolean>();
      let escape!: ReturnType<typeof AsyncLocalStorage.snapshot>;
      mocks.cleanup.mockImplementationOnce(async () => {
        enteredCleanup.resolve();
        return phase === "closing" ? await finishCleanup.promise : phase === "closed";
      });
      const closing = withOpenClawStateDatabaseReadSnapshot(
        async () => {
          escape = AsyncLocalStorage.snapshot();
          expect(getActiveOpenClawStateDatabaseReadSnapshot({ path: source })).toBeDefined();
        },
        { path: source },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      await enteredCleanup.promise;
      if (phase !== "closing") {
        await closing;
      }
      try {
        const observed = await escape(() => probeRetiredAdmission(source));
        expect(observed).toEqual(rejectedAdmissions);
        expect(
          escape(() =>
            getActiveOpenClawStateDatabaseReadSnapshot({ path: path.join(root, "other") }),
          ),
        ).toBeUndefined();
        expect(mocks.forbiddenNative).not.toHaveBeenCalled();
        expect(mocks.read).not.toHaveBeenCalled();
      } finally {
        finishCleanup.resolve(true);
        await closing;
      }
    });
  },
);

it.each(["snapshot", "disposable"] as const)(
  "drains an admitted %s reader while rejecting escaped new reads, then rejects the closed scope",
  async (kind) => {
    await withTempDir("openclaw-draining-read-", async (root) => {
      const source = path.join(root, "source");
      fs.writeFileSync(source, "mock source; never opened as SQLite");
      const started = createDeferredCore();
      const finishRead = createDeferredCore();
      const startedClosing = createDeferredCore();
      const expected: OpenClawStateReadOutcome = {
        value: { ok: true, type: "fleet.list", sourceAdmitted: true, cells: [] },
      };
      mocks.read.mockImplementation(async (_source, authority) => {
        const scopeSignal = getAsyncWorkSignal();
        if (!scopeSignal) {
          throw new Error("Read must be owned by its retained scope");
        }
        scopeSignal.addEventListener("abort", () => startedClosing.resolve(), { once: true });
        started.resolve();
        await finishRead.promise;
        authority.assertCurrent();
        return expected;
      });
      let escape!: ReturnType<typeof AsyncLocalStorage.snapshot>;
      let read!: ReturnType<typeof executeExistingOpenClawStateRead>;
      const callback = async () => {
        escape = AsyncLocalStorage.snapshot();
        read = executeExistingOpenClawStateRead({ path: source }, { type: "fleet.list" });
        await started.promise;
      };
      const closing =
        kind === "snapshot"
          ? withOpenClawStateDatabaseReadSnapshot(callback, { path: source })
          : withDisposableOpenClawStateReads(source, callback);
      await startedClosing.promise;
      try {
        expect(mocks.cleanup).not.toHaveBeenCalled();
        expect(await escape(() => probeRetiredAdmission(source))).toEqual(rejectedAdmissions);
        expect(mocks.read).toHaveBeenCalledOnce();
      } finally {
        finishRead.resolve();
        await read;
        await closing;
      }
      expect(await read).toEqual(expected.value);
      expect(await escape(() => probeRetiredAdmission(source))).toEqual(rejectedAdmissions);
      expect(mocks.forbiddenNative).not.toHaveBeenCalled();
      expect(mocks.cleanup).toHaveBeenCalledTimes(kind === "snapshot" ? 1 : 0);
    });
  },
);
