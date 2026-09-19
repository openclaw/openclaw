import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { PluginBlobStoreError } from "../plugin-state/plugin-blob-store.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import type {
  OpenClawStateReadPhase,
  OpenClawStateReadReply,
} from "./openclaw-state-read.types.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

const mock = vi.hoisted(() => ({
  run: vi.fn<() => Promise<OpenClawStateReadReply>>(),
  close: vi.fn<() => Promise<void>>(),
  notify: undefined as ((error: unknown) => void) | undefined,
}));
vi.mock("./openclaw-state-worker-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-worker-context.js")>();
  return {
    ...actual,
    captureOpenClawStateWorkerContext: vi.fn(actual.captureOpenClawStateWorkerContext),
  };
});
vi.mock("../infra/worker-task-pool.js", () => ({
  WorkerTaskPool: class {
    constructor(options: { onRetirementFailure?: typeof mock.notify }) {
      mock.notify = options.onRetirementFailure;
    }
    run = mock.run;
    close = mock.close;
  },
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    mock.close.mockResolvedValue();
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
  mock.notify = undefined;
  mock.run.mockReset().mockResolvedValue(reply);
  mock.close.mockReset().mockResolvedValue();
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
  return { mapped, mapError: vi.fn((_error: unknown, _phase: OpenClawStateReadPhase) => mapped) };
}

it("maps synchronous read admission refusal once before read work", () => {
  const options = source();
  const original = new Error("original read admission refusal");
  vi.mocked(captureOpenClawStateWorkerContext).mockImplementationOnce(() => {
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

it("keeps a successful source receipt when cleanup rejects", async () => {
  const cleanup = new Error("successful read cleanup failed");
  mock.close.mockRejectedValueOnce(cleanup);
  const { mapped, mapError } = mapper();
  await expect(
    executeExistingOpenClawStateRead(source(), { type: "fleet.list" }, { mapError }),
  ).rejects.toBe(mapped);
  expect(mapError).toHaveBeenCalledExactlyOnceWith(cleanup, "read");
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

it("retains an interrupted successful receipt without publishing its result", async () => {
  const started = createDeferredCore();
  const task = createDeferredCore<OpenClawStateReadReply>();
  mock.run.mockImplementation(() => {
    started.resolve();
    return task.promise;
  });
  const { mapped, mapError } = mapper();
  const pending = executeExistingOpenClawStateRead(source(), { type: "fleet.list" }, { mapError });
  const assertion = expect(pending).rejects.toBe(mapped);
  await started.promise;
  const retirement = new Error("retirement interrupted publication");
  mock.notify?.(retirement);
  task.resolve(reply);
  await assertion;
  expect(mapError).toHaveBeenCalledExactlyOnceWith(retirement, "read");
  expect(mock.close).toHaveBeenCalledOnce();
});
