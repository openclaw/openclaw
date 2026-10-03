import fs from "node:fs";
import path from "node:path";
import type { OwnedWorkerTask } from "@openclaw/worker-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sqliteRuntime from "../infra/bun-sqlite-library.js";
import { createOwnedWorkerTaskPoolMock } from "../infra/worker-task-pool.mock.test-support.js";
import type { RetainedWorkerTask } from "../infra/worker-task-pool.types.js";
import { PluginBlobStoreError } from "../plugin-state/plugin-blob-store.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
} from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { observeAsyncFixture } from "./openclaw-state-db-readonly.test-support.js";
import { withExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import type {
  OpenClawStateReadReceipt,
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";
import { captureOpenClawStateReadWorkerContext } from "./openclaw-state-worker-context.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

const mock = vi.hoisted(() => ({
  run: vi.fn<() => Promise<OpenClawStateReadReply>>(),
  close: vi.fn<OwnedWorkerTask<OpenClawStateReadReply>["close"]>(),
  closePool: vi.fn<() => Promise<void>>(),
  closeResources: vi.fn<(key?: string) => Promise<void>>(),
  rotate: vi.fn<() => Promise<void>>(),
}));
vi.mock("./openclaw-state-worker-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-worker-context.js")>();
  return {
    ...actual,
    captureOpenClawStateReadWorkerContext: vi.fn(actual.captureOpenClawStateReadWorkerContext),
  };
});
vi.mock("../infra/worker-task-pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-task-pool.js")>()),
  createOwnedWorkerTaskPool: () =>
    createOwnedWorkerTaskPoolMock<OpenClawStateReadRequest, OpenClawStateReadReply>({
      startTask: (): RetainedWorkerTask<OpenClawStateReadReply> => ({
        ...observeAsyncFixture(mock.run),
        release: (options) => observeAsyncFixture(() => mock.close(options)),
      }),
      close: mock.closePool,
      closeResources: mock.closeResources,
      rotate: mock.rotate,
    }),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    mock.close.mockResolvedValue();
    mock.closePool.mockResolvedValue();
    mock.closeResources.mockResolvedValue();
    mock.rotate.mockResolvedValue();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
const reply: OpenClawStateReadReply = {
  ok: true,
  type: "fleet.list",
  sourceAdmitted: true,
  cells: [],
};
beforeEach(() => {
  mock.run.mockReset().mockResolvedValue(reply);
  mock.close.mockReset().mockResolvedValue();
  mock.closePool.mockReset().mockResolvedValue();
  mock.closeResources.mockReset().mockResolvedValue();
  mock.rotate.mockReset().mockResolvedValue();
});
function source() {
  const root = tempDirs.make("state-read-error-phase-");
  const pathname = path.join(root, "source.sqlite");
  // The mocked worker uses only this filesystem identity; no SQLite connection opens.
  fs.writeFileSync(pathname, "mock transport source");
  return { path: pathname, env: { OPENCLAW_STATE_DIR: root } };
}
function mapper() {
  const mapped = new Error("mapped read failure");
  return {
    mapped,
    mapError: vi.fn((_error: unknown, _phase: OpenClawStateReadReceipt["phase"]) => mapped),
  };
}

it.each([false, true])(
  "closes a mapped reader with explicit SQLite close capability %s",
  async (explicitClose) => {
    const capabilities = vi.spyOn(sqliteRuntime, "getSqliteRuntimeCapabilities").mockReturnValue({
      explicitSqliteCloseReleasesNativeResources: explicitClose,
      decided: true,
      reason: "test policy",
    });
    try {
      const options = source();
      await executeExistingOpenClawStateRead(options, { type: "fleet.list" });
      await closeOpenClawStateDatabaseByPathAsync(options.path);
      expect(explicitClose ? mock.closeResources : mock.rotate).toHaveBeenCalledOnce();
      expect(explicitClose ? mock.rotate : mock.closeResources).not.toHaveBeenCalled();
      expect(mock.closePool).not.toHaveBeenCalled();
      await closeOpenClawStateDatabaseAsync();
      expect(mock.closePool).toHaveBeenCalledOnce();
    } finally {
      capabilities.mockRestore();
    }
  },
);

it.each(["retired", "different-source"] as const)(
  "maps %s captured authority before dispatching a read",
  async (kind) => {
    const options = source();
    const context = captureOpenClawStateReadWorkerContext(options);
    if (kind === "retired") {
      await closeOpenClawStateDatabaseByPathAsync(options.path);
    }
    const { mapped, mapError } = mapper();
    let failure: unknown;
    try {
      await executeExistingOpenClawStateRead(
        kind === "different-source" ? source() : options,
        { type: "fleet.list" },
        { context, mapError },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBe(mapped);
    expect(mapError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(
        kind === "retired"
          ? { code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED" }
          : { message: "Shared-state read context does not match its selected source" },
      ),
      "before-read",
    );
    expect(mock.run).not.toHaveBeenCalled();
    expect(mock.close).not.toHaveBeenCalled();
  },
);

it("maps synchronous read admission refusal once before read work", () => {
  const options = source();
  const original = new Error("original read admission refusal");
  vi.mocked(captureOpenClawStateReadWorkerContext).mockImplementationOnce(() => {
    throw original;
  });
  const { mapped, mapError } = mapper();
  expect(() =>
    executeExistingOpenClawStateRead(options, { type: "fleet.list" }, { mapError }),
  ).toThrow(mapped);
  expect(mapError).toHaveBeenCalledExactlyOnceWith(original, "before-read");
  expect(mock.run).not.toHaveBeenCalled();
  expect(mock.close).not.toHaveBeenCalled();
});

it("maps captured schema scope retirement once before read work", () => {
  const options = source();
  const context = withExistingOpenClawStateSchema({ path: options.path }, () =>
    captureOpenClawStateReadWorkerContext(options),
  );
  const { mapped, mapError } = mapper();
  expect(() =>
    executeExistingOpenClawStateRead(options, { type: "fleet.list" }, { context, mapError }),
  ).toThrow(mapped);
  expect(mapError).toHaveBeenCalledOnce();
  expect(mapError.mock.calls[0]?.[1]).toBe("before-read");
  expect(mock.run).not.toHaveBeenCalled();
  expect(mock.close).not.toHaveBeenCalled();
});

it("maps an authoritative pre-read error after cleanup", async () => {
  const original = new Error("source admission failed");
  mock.run.mockResolvedValue({
    ok: false,
    message: original.message,
    error: encodeOpenClawStateWorkerError(original, { includeOrdinary: true }),
  });
  const { mapped, mapError } = mapper();
  await expect(
    executeExistingOpenClawStateRead(source(), { type: "fleet.list" }, { mapError }),
  ).rejects.toBe(mapped);
  expect(mapError).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: original.message }),
    "before-read",
  );
  expect(mock.close).toHaveBeenCalledOnce();
  expect(mock.close.mock.invocationCallOrder[0]).toBeLessThan(
    mapError.mock.invocationCallOrder[0]!,
  );
});

it("maps the full Blob query and cleanup error graph after observing its receipt", async () => {
  const original = new PluginBlobStoreError("query failed", {
    code: "PLUGIN_BLOB_CORRUPT",
    operation: "lookup",
    path: "/fixture/blob.sqlite",
  });
  mock.run.mockResolvedValue({
    ok: false,
    sourceAdmitted: true,
    message: original.message,
    error: encodeOpenClawStateWorkerError(original),
  });
  const cleanup = new Error("cleanup failed");
  mock.close.mockRejectedValueOnce(cleanup);
  const { mapped, mapError } = mapper();
  await expect(
    executeExistingOpenClawStateRead(source(), { type: "fleet.list" }, { mapError }),
  ).rejects.toBe(mapped);
  expect(mapError).toHaveBeenCalledOnce();
  const [error, phase] = mapError.mock.calls[0]!;
  expect(phase).toBe("read");
  expect(error).toBeInstanceOf(AggregateError);
  if (!(error instanceof AggregateError)) {
    throw new Error("Expected aggregate");
  }
  expect(error.errors[0]).toBeInstanceOf(PluginBlobStoreError);
  expect(error.errors[0]).toMatchObject({
    code: original.code,
    operation: original.operation,
    path: original.path,
  });
  expect(error.errors[1]).toBe(cleanup);
  expect(error.cause).toBe(error.errors[0]);
});

it("does not infer pre-read admission from an unobserved transport failure", async () => {
  const original = new Error("no authoritative reply");
  mock.run.mockRejectedValue(original);
  const { mapped, mapError } = mapper();
  await expect(
    executeExistingOpenClawStateRead(source(), { type: "fleet.list" }, { mapError }),
  ).rejects.toBe(mapped);
  expect(mapError).toHaveBeenCalledExactlyOnceWith(original, "unobserved");
});

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
  const pending = executeExistingOpenClawStateRead(options, { type: "fleet.list" }, { mapError });
  const assertion = expect(pending.then(publish)).rejects.toBe(mapped);
  const cleanup = new Error("successful read cleanup failed");
  try {
    await closing.promise;
    expect(publish).not.toHaveBeenCalled();
    expect(mapError).not.toHaveBeenCalled();
    expect(mock.closePool).not.toHaveBeenCalled();
  } finally {
    stopped.reject(cleanup);
  }
  await assertion;
  expect(mapError).toHaveBeenCalledExactlyOnceWith(cleanup, "read");
  expect(mock.close).toHaveBeenCalledOnce();
  await closeOpenClawStateDatabaseByPathAsync(options.path);
  expect(mock.close).toHaveBeenCalledTimes(2);
  expect(mock.closePool).not.toHaveBeenCalled();
  expect(publish).not.toHaveBeenCalled();
  await expect(pending).rejects.toBe(mapped);
  expect(mapError).toHaveBeenCalledOnce();
});
