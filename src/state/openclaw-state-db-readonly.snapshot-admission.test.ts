import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { StateDatabaseAdmissionPendingError } from "../infra/gateway-state-owner-record.js";
import { cleanupSnapshotOperations } from "../infra/sqlite-readonly-location-cleanup.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { createReadWorkerFixture } from "./openclaw-state-db-readonly.test-support.js";
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

vi.mock("./openclaw-state-read-worker.js", () =>
  createReadWorkerFixture(mocks.read, async () => {}),
);

import { isStateDatabaseReadAdmissionInvalidatedError } from "./openclaw-state-db-async-lifecycle.js";
import {
  executeExistingOpenClawStateRead,
  getActiveOpenClawStateDatabaseReadSnapshot,
  withDisposableOpenClawStateReads,
  withExistingOpenClawStateDatabaseCurrentReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
  withOpenClawStateDatabaseReadSnapshot,
  withSynchronousArtifactPreservingStateSnapshot,
} from "./openclaw-state-db-readonly.js";
import {
  getExistingOpenClawStateSchemaPath,
  withExistingOpenClawStateSchema,
} from "./openclaw-state-db-schema-policy.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

beforeEach(() => {
  mocks.forbiddenNative.mockClear();
  mocks.read.mockReset().mockResolvedValue({
    value: { ok: true, type: "fleet.list", sourceAdmitted: true, cells: [] },
  });
  mocks.assertCurrent.mockReset();
  mocks.assertFresh.mockReset();
  mocks.cleanup.mockReset().mockResolvedValue(true);
  mocks.capture.mockReset().mockImplementation((databasePath: string) => ({
    databasePath,
    identity: {},
    assertCurrent: mocks.assertCurrent,
  }));
  mocks.prepare.mockReset().mockResolvedValue({
    location: "/fixture/private.sqlite",
    cleanupAsync: mocks.cleanup,
  });
});

it("waits for temporary schema custody before admitting one discovery snapshot", async () => {
  await withTempDir("openclaw-discovery-cold-admission-", async (root) => {
    const source = path.join(root, "source");
    fs.writeFileSync(source, "mock snapshot source; never opened as SQLite");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      mocks.assertFresh.mockImplementation(() => {
        if (performance.now() < 9_000) {
          throw new StateDatabaseAdmissionPendingError(source, "temporary schema custody");
        }
      });
      const operation = vi.fn(async () => "admitted");
      const read = withOpenClawStateDatabaseReadSnapshot(operation, {
        path: source,
        admissionTimeoutMs: 300_000,
      });
      const outcome = read.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(9_000);
      expect(await outcome).toEqual({ value: "admitted" });
      expect(operation).toHaveBeenCalledOnce();
      expect(mocks.cleanup).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

it.each([
  "maintenance",
  "other database",
  "default",
  "exhausted",
  "cancelled",
  "shutdown",
] as const)("refuses %s before preparing discovery bytes", async (kind) => {
  await withTempDir("openclaw-discovery-cold-refusal-", async (root) => {
    const source = path.join(root, "source");
    fs.writeFileSync(source, "mock snapshot source; never opened as SQLite");
    const refusal =
      kind === "maintenance"
        ? new Error("genuine offline maintenance")
        : new StateDatabaseAdmissionPendingError(
            kind === "other database" ? path.join(root, "other") : source,
            "temporary schema custody",
          );
    const caller = new AsyncWorkScope();
    const cancelled = new Error("caller closed while waiting for schema custody");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      mocks.assertFresh.mockImplementation(() => {
        throw refusal;
      });
      const operation = vi.fn(async () => "must not enter");
      const read = caller.track(() =>
        withOpenClawStateDatabaseReadSnapshot(operation, {
          path: source,
          admissionTimeoutMs: kind === "default" ? undefined : 300_000,
        }),
      );
      let settled = false;
      const outcome = read
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        .then((result) => {
          settled = true;
          return result;
        });
      if (kind === "exhausted") {
        await vi.advanceTimersByTimeAsync(299_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      } else if (kind === "cancelled") {
        caller.beginClose(cancelled);
      } else if (kind === "shutdown") {
        await cleanupSnapshotOperations();
      }
      expect(await outcome).toMatchObject({
        error: {
          cause:
            kind === "cancelled"
              ? { name: "AbortError", cause: cancelled }
              : kind === "shutdown"
                ? { name: "AbortError" }
                : refusal,
        },
      });
      expect(mocks.capture).not.toHaveBeenCalled();
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
      expect(mocks.cleanup).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      caller.beginClose(cancelled);
      await caller.drain();
      vi.useRealTimers();
    }
  });
});

it.each(["capture", "cleanup"] as const)(
  "preserves discovery %s failure and retires snapshot admission",
  async (phase) => {
    await withTempDir("openclaw-discovery-admission-", async (root) => {
      const source = path.join(root, "source");
      fs.writeFileSync(source, "mock snapshot source; never opened as SQLite");
      const failure = new Error("synthetic admission refusal");
      const fail = () => {
        throw failure;
      };
      if (phase === "capture") {
        mocks.capture.mockImplementation(fail);
      }
      let escape!: ReturnType<typeof AsyncLocalStorage.snapshot>;
      if (phase === "cleanup") {
        mocks.cleanup.mockResolvedValueOnce(false);
      }
      const operation = vi.fn(async () => {
        escape = AsyncLocalStorage.snapshot();
        expect(getActiveOpenClawStateDatabaseReadSnapshot({ path: source })).toBeDefined();
        return 1;
      });
      const result = withOpenClawStateDatabaseReadSnapshot(operation, { path: source });
      if (phase === "capture") {
        await expect(result).rejects.toMatchObject({
          message: expect.stringContaining(`Cannot read shared state for discovery: ${source}`),
          cause: failure,
        });
        expect(mocks.prepare).not.toHaveBeenCalled();
      } else {
        await expect(result).rejects.toThrow("snapshot cleanup failed");
        expect(await escape(() => probeRetiredAdmission(source))).toEqual(rejectedAdmissions);
        expect(
          escape(() =>
            getActiveOpenClawStateDatabaseReadSnapshot({ path: path.join(root, "other") }),
          ),
        ).toBeUndefined();
        expect(mocks.forbiddenNative).not.toHaveBeenCalled();
        expect(mocks.read).not.toHaveBeenCalled();
      }
      if (phase !== "cleanup") {
        expect(operation).not.toHaveBeenCalled();
      }
    });
  },
);

// Escaped continuations retain ALS, but admission ends before private bytes are removed.
async function probeRetiredAdmission(source: string) {
  const options = { path: source };
  const attempts = {
    getter: () => getActiveOpenClawStateDatabaseReadSnapshot(options),
    native: () => withExistingOpenClawStateDatabaseReadOnly(() => "read", options),
    currentRows: () => withExistingOpenClawStateDatabaseCurrentReadOnly(() => "read", options),
    currentSnapshot: () =>
      withSynchronousArtifactPreservingStateSnapshot(() => "read", { current: options }),
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
  currentSnapshot: true,
  nestedSnapshot: true,
  nestedDisposable: true,
  worker: true,
};

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

it("keeps captured schema authority while selecting current rows", async () => {
  await withTempDir("openclaw-current-captured-read-", async (root) => {
    const source = path.join(root, "source");
    fs.writeFileSync(source, "mock source; never opened as SQLite");
    await withExistingOpenClawStateSchema({ path: source }, () =>
      withOpenClawStateDatabaseReadSnapshot(
        async () => {
          const context = captureOpenClawStateWorkerContext({ path: source });
          mocks.read.mockImplementation(async (location) => {
            expect(location.context).toBe(context);
            expect(getExistingOpenClawStateSchemaPath()).toBe(source);
            expect(location.location).toBe(source);
            return { value: { ok: true, type: "fleet.list", sourceAdmitted: true, cells: [] } };
          });
          await expect(
            executeExistingOpenClawStateRead(
              { path: source },
              { type: "fleet.list" },
              { current: true, context },
            ),
          ).resolves.toMatchObject({ ok: true, cells: [] });
          expect(mocks.read).toHaveBeenCalledOnce();
        },
        { path: source },
      ),
    );
    expect(mocks.forbiddenNative).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });
});
