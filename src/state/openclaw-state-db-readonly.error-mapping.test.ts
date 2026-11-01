import assert from "node:assert/strict";
import type { OwnedWorkerTask } from "@openclaw/worker-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqliteRuntime from "../infra/bun-sqlite-library.js";
import { createOwnedWorkerTaskPoolMock } from "../infra/worker-task-pool.mock.test-support.js";
import { PluginBlobStoreError } from "../plugin-state/plugin-blob-store.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync as closeState,
  closeOpenClawStateDatabaseByPathAsync as closePath,
} from "./openclaw-state-db-cache.js";
import { expectCalls, makeReadSource } from "./openclaw-state-db-fixtures.test-support.js";
import { executeExistingOpenClawStateRead as readExisting } from "./openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema as withExistingSchema } from "./openclaw-state-db-schema-policy.js";
import type {
  OpenClawStateReadReceipt,
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";
import { captureOpenClawStateReadWorkerContext as captureReadContext } from "./openclaw-state-worker-context.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

const mock = vi.hoisted(() => ({
  run: vi.fn<() => Promise<OpenClawStateReadReply>>(),
  close: vi.fn<OwnedWorkerTask<OpenClawStateReadReply>["close"]>(),
  closePool: vi.fn<() => Promise<void>>(),
  closeResources: vi.fn<(key?: string) => Promise<void>>(),
  rotate: vi.fn<() => Promise<void>>(),
}));
vi.mock("../infra/worker-task-pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-task-pool.js")>()),
  createOwnedWorkerTaskPool: () =>
    createOwnedWorkerTaskPoolMock<OpenClawStateReadRequest, OpenClawStateReadReply>({
      runTask: () => ({
        result: mock.run(),
        close: mock.close,
      }),
      close: mock.closePool,
      closeResources: mock.closeResources,
      rotate: mock.rotate,
    }),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const method of [mock.close, mock.closePool, mock.closeResources, mock.rotate]) {
      method.mockResolvedValue();
    }
    vi.restoreAllMocks();
    await closeState();
    cleanup();
  }),
);
const reply: OpenClawStateReadReply = {
  ok: true,
  type: "backup.runs",
  sourceAdmitted: true,
  runs: [],
};
beforeEach(() => {
  mock.run.mockReset().mockResolvedValue(reply);
  for (const method of [mock.close, mock.closePool, mock.closeResources, mock.rotate]) {
    method.mockReset().mockResolvedValue();
  }
});
function source() {
  return makeReadSource(tempDirs, "state-read-error-phase-");
}
function mapper() {
  const mapped = new Error("mapped read failure");
  return {
    mapped,
    mapError: vi.fn((_error: unknown, _phase: OpenClawStateReadReceipt["phase"]) => mapped),
  };
}

it("rotates mapped readers when explicit SQLite close cannot release native resources", async () => {
  vi.spyOn(sqliteRuntime, "getSqliteRuntimeCapabilities").mockReturnValue({
    explicitSqliteCloseReleasesNativeResources: false,
    decided: true,
    reason: "test policy",
  });
  const options = source();
  await readExisting(options, { type: "backup.runs" });
  await closePath(options.path);
  expect(mock.rotate).toHaveBeenCalledOnce();
  expectCalls(0, mock.closeResources, mock.closePool);
  await closeState();
  expect(mock.closePool).toHaveBeenCalledOnce();
});

it.each(["retired", "different-source", "schema"] as const)(
  "maps %s authority failure once before dispatching a read",
  async (kind) => {
    const options = source();
    const context =
      kind === "schema"
        ? withExistingSchema({ path: options.path }, () => captureReadContext(options))
        : captureReadContext(options);
    if (kind === "retired") {
      await closePath(options.path);
    }
    const { mapped, mapError } = mapper();
    const read = () =>
      readExisting(
        kind === "different-source" ? source() : options,
        { type: "backup.runs" },
        { context, mapError },
      );
    if (kind === "schema") {
      expect(read).toThrow(mapped);
    } else {
      await expect(Promise.resolve().then(read)).rejects.toBe(mapped);
    }
    expect(mapError).toHaveBeenCalledExactlyOnceWith(
      kind === "schema"
        ? expect.anything()
        : expect.objectContaining(
            kind === "retired"
              ? { code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" }
              : { message: "Shared-state read context does not match its selected source" },
          ),
      "before-read",
    );
    expectCalls(0, mock.run, mock.close);
  },
);

it.each(["before-read", "read", "unobserved"] as const)(
  "maps the complete %s failure after transport cleanup",
  async (phase) => {
    const blobDetails = {
      code: "PLUGIN_BLOB_CORRUPT" as const,
      operation: "lookup" as const,
      path: "/fixture/blob.sqlite",
    };
    const original =
      phase === "read"
        ? new PluginBlobStoreError("query failed", blobDetails)
        : new Error("source admission or transport failed");
    const cleanup = new Error("cleanup failed");
    if (phase === "unobserved") {
      mock.run.mockRejectedValue(original);
    } else {
      mock.run.mockResolvedValue({
        ok: false,
        ...(phase === "read" ? { sourceAdmitted: true } : {}),
        message: original.message,
        error: encodeOpenClawStateWorkerError(original, { includeOrdinary: true }),
      });
      if (phase === "read") {
        mock.close.mockRejectedValueOnce(cleanup);
      }
    }
    const { mapped, mapError } = mapper();
    await expect(readExisting(source(), { type: "backup.runs" }, { mapError })).rejects.toBe(
      mapped,
    );
    expectCalls(1, mapError, mock.close);
    expect(mock.close.mock.invocationCallOrder[0]).toBeLessThan(
      mapError.mock.invocationCallOrder[0]!,
    );
    const [error, observedPhase] = mapError.mock.calls[0]!;
    expect(observedPhase).toBe(phase);
    if (phase === "read") {
      assert(error instanceof AggregateError);
      expect(error.errors[0]).toBeInstanceOf(PluginBlobStoreError);
      expect(error.errors[0]).toMatchObject(blobDetails);
      expect(error.errors[1]).toBe(cleanup);
      expect(error.cause).toBe(error.errors[0]);
    } else {
      expect(mapError).toHaveBeenCalledExactlyOnceWith(
        phase === "unobserved" ? original : expect.objectContaining({ message: original.message }),
        phase,
      );
    }
  },
);

it("retains a successful receipt through failed task cleanup and canonical retry", async () => {
  const options = source();
  const closing = createDeferredCore();
  const stopped = createDeferredCore();
  mock.close.mockImplementationOnce(() => {
    closing.resolve();
    return stopped.promise;
  });
  const { mapped, mapError } = mapper();
  const publish = vi.fn();
  const pending = readExisting(options, { type: "backup.runs" }, { mapError });
  const assertion = expect(pending.then(publish)).rejects.toBe(mapped);
  const cleanup = new Error("successful read cleanup failed");
  try {
    await closing.promise;
    expectCalls(0, publish, mapError, mock.closePool);
  } finally {
    stopped.reject(cleanup);
  }
  await assertion;
  expect(mapError).toHaveBeenCalledExactlyOnceWith(cleanup, "read");
  expect(mock.close).toHaveBeenCalledOnce();
  await closePath(options.path);
  expect(mock.close).toHaveBeenCalledTimes(2);
  expectCalls(0, mock.closePool, publish);
  await expect(pending).rejects.toBe(mapped);
  expect(mapError).toHaveBeenCalledOnce();
});
