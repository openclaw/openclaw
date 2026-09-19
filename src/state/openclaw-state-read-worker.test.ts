import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ExecutionIdentityInspectionQuery } from "../audit/execution-identity-inspection.types.js";
import type {
  OwnedWorkerTask,
  WorkerTaskInput,
  WorkerTaskOptions,
} from "../infra/worker-task-pool.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawStateReadTransport } from "./openclaw-state-read-worker.js";
import type {
  OpenClawStateReadReply,
  OpenClawStateReadRequest,
} from "./openclaw-state-read.types.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

type ReadTask = OwnedWorkerTask<OpenClawStateReadReply>;
type RunTask = (
  input: WorkerTaskInput<OpenClawStateReadRequest>,
  options: WorkerTaskOptions<OpenClawStateReadRequest>,
) => ReadTask;
const mock = vi.hoisted(() => ({
  create: vi.fn(),
  runTask: vi.fn<RunTask>(),
  closePool: vi.fn<() => Promise<void>>(),
  selectSqlite:
    vi.fn<typeof import("../infra/bun-sqlite-library.js").ensureSqliteLibrarySelected>(),
}));
vi.mock("../infra/bun-sqlite-library.js", () => ({
  ensureSqliteLibrarySelected: mock.selectSqlite,
}));
vi.mock("../infra/worker-task-pool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-task-pool.js")>()),
  createOwnedWorkerTaskPool: mock.create,
}));

import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db.js";

const taskCleanups: Array<() => void> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const release of taskCleanups.splice(0)) {
      release();
    }
    mock.closePool.mockReset().mockResolvedValue();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
beforeEach(() => {
  mock.selectSqlite.mockReset().mockReturnValue({ source: "runtime" });
  mock.runTask.mockReset();
  mock.closePool.mockReset().mockResolvedValue();
  mock.create.mockReset().mockImplementation(() => ({
    runTask: mock.runTask,
    close: mock.closePool,
  }));
});

function source(name = "source.sqlite") {
  const root = tempDirs.make("openclaw-read-owned-task-");
  const pathname = path.join(root, name);
  // Only filesystem identity is real; no mocked task opens SQLite.
  fs.writeFileSync(pathname, "mock worker source");
  return { root, pathname, options: { path: pathname, env: { OPENCLAW_STATE_DIR: root } } };
}

function queueTask(dispatchReady: Promise<void> = Promise.resolve()) {
  const result = createDeferredCore<OpenClawStateReadReply>();
  const submitted = createDeferredCore<WorkerTaskOptions<OpenClawStateReadRequest>>();
  const captured = createDeferredCore<OpenClawStateReadRequest>();
  const close = vi.fn<ReadTask["close"]>().mockResolvedValue();
  const handle: ReadTask = { result: result.promise, close };
  let detach = () => {};
  mock.runTask.mockImplementationOnce((input, options) => {
    const signal = options.signal;
    const abort = () => result.reject(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    detach = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted) {
      abort();
    }
    submitted.resolve(options);
    void dispatchReady
      .then(async () => {
        const request = typeof input === "function" ? await input() : input;
        captured.resolve(request);
      })
      .catch((error: unknown) => {
        captured.reject(error);
        result.reject(error);
      });
    return handle;
  });
  void captured.promise.catch(() => undefined);
  taskCleanups.push(() => {
    detach();
    close.mockReset().mockResolvedValue();
    result.reject(new Error("test task cleanup"));
  });
  return { result, submitted: submitted.promise, captured: captured.promise, close };
}

const emptyReply: OpenClawStateReadReply = {
  ok: true,
  type: "fleet.list",
  sourceAdmitted: true,
  cells: [],
};

it.each([false, true])(
  "preserves task and cleanup errors across explicit retirement retries (retry fails=%s)",
  async (retryFails) => {
    const { pathname, options } = source();
    const task = queueTask();
    const original = new Error("original worker task failed");
    const retirement = new Error("first worker stop failed");
    const retryFailure = new Error("second worker stop failed");
    task.close.mockRejectedValueOnce(retirement);
    if (retryFails) {
      task.close.mockRejectedValueOnce(retryFailure);
    }
    const result = executeExistingOpenClawStateRead(options, { type: "fleet.list" });
    const assertion = expect(result).rejects.toMatchObject({
      cause: original,
      errors: [original, retirement],
    });
    await task.captured;
    task.result.reject(original);
    await assertion;
    expect(task.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
    expect(mock.closePool).not.toHaveBeenCalled();

    // Result and native settlement are separate: the initial close reports the
    // cached first stop failure; only a later lifecycle close retries that stop.
    if (retryFails) {
      await expect(closeOpenClawStateDatabaseByPathAsync(pathname)).rejects.toBe(retryFailure);
      expect(task.close).toHaveBeenCalledTimes(2);
    }
    await closeOpenClawStateDatabaseByPathAsync(pathname);
    expect(task.close).toHaveBeenCalledTimes(retryFails ? 3 : 2);
    await closeOpenClawStateDatabaseByPathAsync(pathname);
    expect(task.close).toHaveBeenCalledTimes(retryFails ? 3 : 2);
    expect(mock.closePool).not.toHaveBeenCalled();
    expect(mock.runTask).toHaveBeenCalledOnce();
    await expect(result).rejects.toMatchObject({ cause: original, errors: [original, retirement] });
  },
);

it("reads externally created state after an absent read without allocating a worker first", async () => {
  const root = tempDirs.make("openclaw-read-first-creation-");
  const pathname = path.join(root, "source.sqlite");
  const options = { path: pathname, env: { OPENCLAW_STATE_DIR: root } };
  const command = { type: "fleet.list" } as const;
  expect(await executeExistingOpenClawStateRead(options, command)).toBeUndefined();
  expect(fs.existsSync(pathname)).toBe(false);
  expect(mock.create).not.toHaveBeenCalled();
  expect(mock.runTask).not.toHaveBeenCalled();
  expect(mock.selectSqlite).not.toHaveBeenCalled();

  fs.writeFileSync(pathname, "mock worker source");
  const task = queueTask();
  task.result.resolve(emptyReply);
  expect(await executeExistingOpenClawStateRead(options, command)).toEqual(emptyReply);
  expect(mock.selectSqlite).toHaveBeenCalledOnce();
  expect(task.close).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(mock.closePool).not.toHaveBeenCalled();
});

it.each(["query failed", "native reader close failed"])(
  "retires an encoded %s reply and retains operation custody until stop",
  async (message) => {
    const { options } = source();
    const task = queueTask();
    const stopping = createDeferredCore();
    const stopped = createDeferredCore();
    task.close.mockImplementationOnce(() => {
      stopping.resolve();
      return stopped.promise;
    });
    const result = executeExistingOpenClawStateRead(options, { type: "fleet.list" });
    const assertion = expect(result).rejects.toThrow(message);
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await task.captured;
    task.result.resolve({
      ok: false,
      sourceAdmitted: true,
      message,
      error: encodeOpenClawStateWorkerError(new Error(message), { includeOrdinary: true }),
    });
    try {
      await stopping.promise;
      expect(task.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
      expect(settled).toBe(false);
      expect(mock.closePool).not.toHaveBeenCalled();
    } finally {
      stopped.resolve();
      await assertion;
    }
  },
);

it.each(["cleanup-fact", "bun"] as const)(
  "preserves a successful read only after required retirement (%s)",
  async (reason) => {
    const { options } = source();
    const task = queueTask();
    const stopping = createDeferredCore();
    const stopped = createDeferredCore();
    task.close.mockImplementationOnce(() => {
      stopping.resolve();
      return stopped.promise;
    });
    if (reason === "bun") {
      // Policy-only control: the task and its native retirement are both mocked.
      vi.stubGlobal("process", {
        ...process,
        versions: { ...process.versions, bun: "1.4.2" },
      });
    }
    try {
      const result = executeExistingOpenClawStateRead(options, { type: "fleet.list" });
      let settled = false;
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await task.captured;
      task.result.resolve(
        reason === "cleanup-fact"
          ? { ...emptyReply, nativeCleanupFailure: { error: undefined } }
          : emptyReply,
      );
      try {
        await stopping.promise;
        expect(task.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
        expect(mock.selectSqlite).toHaveBeenCalledOnce();
        expect(mock.selectSqlite.mock.invocationCallOrder[0]).toBeLessThan(
          mock.create.mock.invocationCallOrder[0]!,
        );
        expect(settled).toBe(false);
        expect(mock.closePool).not.toHaveBeenCalled();
      } finally {
        stopped.resolve();
      }
      await expect(result).resolves.toMatchObject({ ok: true, type: "fleet.list", cells: [] });
      expect(task.close).toHaveBeenCalledOnce();
    } finally {
      stopped.resolve();
      if (reason === "bun") {
        vi.unstubAllGlobals();
      }
    }
  },
);

it.each([false, true])(
  "preserves the quarantine cleanup graph and stop failure (source fails=%s)",
  async (sourceFails) => {
    const { pathname, options } = source();
    const task = queueTask();
    const metadata = new Error("quarantine metadata read failed");
    const nativeClose = new Error("quarantine reader close failed");
    const quarantine = new AggregateError([metadata, nativeClose], "quarantine read and cleanup", {
      cause: metadata,
    });
    const primary = new Error("source query failed");
    const stop = new Error("worker native exit not confirmed");
    task.close.mockRejectedValueOnce(stop);
    const result = executeExistingOpenClawStateRead(options, { type: "fleet.list" });
    const outcome = result.catch((error: unknown) => error);
    await task.captured;
    const reply: OpenClawStateReadReply = sourceFails
      ? {
          ok: false,
          sourceAdmitted: true,
          message: primary.message,
          error: encodeOpenClawStateWorkerError(primary, { includeOrdinary: true }),
        }
      : emptyReply;
    task.result.resolve({
      ...reply,
      nativeCleanupFailure: {
        error: encodeOpenClawStateWorkerError(quarantine, { includeOrdinary: true }),
      },
    });
    const failure = await outcome;
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error("Read cleanup did not retain its error graph");
    }
    expect(failure.cause).toBe(failure.errors[0]);
    expect(failure.errors).toHaveLength(2);
    if (sourceFails) {
      expect(failure.cause).toMatchObject({ message: primary.message });
    }
    const cleanup: unknown = sourceFails ? failure.errors[1] : failure;
    expect(cleanup).toBeInstanceOf(AggregateError);
    if (!(cleanup instanceof AggregateError)) {
      throw new Error("Worker stop replaced the quarantine cleanup graph");
    }
    expect(cleanup.cause).toBe(cleanup.errors[0]);
    expect(cleanup.errors).toHaveLength(2);
    expect(cleanup.errors[1]).toBe(stop);
    const decoded: unknown = cleanup.errors[0];
    expect(decoded).toBeInstanceOf(AggregateError);
    if (!(decoded instanceof AggregateError)) {
      throw new Error("Encoded quarantine failures were not retained");
    }
    expect(decoded.message).toBe(quarantine.message);
    expect(decoded.errors).toMatchObject([
      { message: metadata.message },
      { message: nativeClose.message },
    ]);
    expect(decoded.cause).toBe(decoded.errors[0]);
    expect(task.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
    expect(mock.closePool).not.toHaveBeenCalled();

    await closeOpenClawStateDatabaseByPathAsync(pathname);
    expect(task.close).toHaveBeenCalledTimes(2);
    await expect(result).rejects.toBe(failure);
  },
);

it("releases one completed read without closing the shared pool or aborting another read", async () => {
  const { options } = source();
  const first = queueTask();
  const sibling = queueTask();
  const firstRead = executeExistingOpenClawStateRead(options, { type: "fleet.list" });
  const siblingRead = executeExistingOpenClawStateRead(options, { type: "fleet.list" });
  await Promise.all([first.captured, sibling.captured]);
  const siblingOptions = await sibling.submitted;
  first.result.resolve(emptyReply);
  expect(await firstRead).toEqual(emptyReply);
  expect(first.close).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(sibling.close).not.toHaveBeenCalled();
  expect(siblingOptions.signal?.aborted).toBe(false);
  expect(mock.closePool).not.toHaveBeenCalled();
  expect(mock.create).toHaveBeenCalledOnce();

  sibling.result.resolve(emptyReply);
  expect(await siblingRead).toEqual(emptyReply);
  expect(sibling.close).toHaveBeenCalledExactlyOnceWith(undefined);
  await closeOpenClawStateDatabaseAsync();
  expect(mock.closePool).toHaveBeenCalledOnce();
});

it("closes only the operation matching a state path while its sibling finishes normally", async () => {
  const firstSource = source("first.sqlite");
  const siblingSource = source("sibling.sqlite");
  const first = queueTask();
  const sibling = queueTask();
  const firstRead = executeExistingOpenClawStateRead(firstSource.options, { type: "fleet.list" });
  const assertion = expect(firstRead).rejects.toThrow(/read admission (?:is )?closed/i);
  const siblingRead = executeExistingOpenClawStateRead(siblingSource.options, {
    type: "fleet.list",
  });
  await Promise.all([first.captured, sibling.captured]);
  const firstOptions = await first.submitted;
  const siblingOptions = await sibling.submitted;
  await closeOpenClawStateDatabaseByPathAsync(firstSource.pathname);
  await assertion;
  expect(firstOptions.signal?.aborted).toBe(true);
  expect(first.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
  expect(siblingOptions.signal?.aborted).toBe(false);
  expect(sibling.close).not.toHaveBeenCalled();
  expect(mock.closePool).not.toHaveBeenCalled();
  expect(mock.create).toHaveBeenCalledOnce();

  sibling.result.resolve(emptyReply);
  expect(await siblingRead).toEqual(emptyReply);
  await closeOpenClawStateDatabaseAsync();
  expect(mock.closePool).toHaveBeenCalledOnce();
});

it("charges retained UTF-8 input and keeps the captured request while dispatch waits", async () => {
  const { options } = source();
  const tenantId = "租户🦞".repeat(512);
  const command = { type: "fleet.get" as const, tenantId };
  const dispatch = createDeferredCore();
  const task = queueTask(dispatch.promise);
  const result = executeExistingOpenClawStateRead(options, command);
  const submitted = await task.submitted;
  expect(Number.isSafeInteger(submitted.inputBytes)).toBe(true);
  expect(submitted.inputBytes).toBeGreaterThanOrEqual(Buffer.byteLength(tenantId));
  const originalRoot = options.env.OPENCLAW_STATE_DIR;
  command.tenantId = "different tenant after admission";
  options.env.OPENCLAW_STATE_DIR = path.join(originalRoot, "different");
  const returned: OpenClawStateReadReply = {
    ok: true,
    type: "fleet.get",
    sourceAdmitted: true,
    cell: undefined,
  };
  try {
    dispatch.resolve();
    const request = await task.captured;
    expect(request.command).toEqual({ type: "fleet.get", tenantId });
    expect(request.context.environment.OPENCLAW_STATE_DIR).toBe(originalRoot);
    task.result.resolve(returned);
    expect(await result).toEqual(returned);
  } finally {
    dispatch.resolve();
  }
});

it.each([
  {
    input: {
      runId: "运行🦞",
      now: 0,
      executionOffset: 0,
      executionLimit: 0,
      decisionLimit: 0,
      decisionCursor: "游标🦞",
    },
    numericBytes: 32,
  },
  { input: { runId: "运行🦞", now: 0 }, numericBytes: 8 },
  {
    input: { executionId: "执行🦞", now: 0, decisionLimit: 0, decisionCursor: "游标🦞" },
    numericBytes: 16,
  },
  { input: { executionId: "执行🦞", now: 0 }, numericBytes: 8 },
] satisfies Array<{ input: ExecutionIdentityInspectionQuery; numericBytes: number }>)(
  "captures audit query before preparation and charges queued scalar input: $input",
  async ({
    input,
    numericBytes,
  }: {
    input: ExecutionIdentityInspectionQuery;
    numericBytes: number;
  }) => {
    const { pathname, options } = source();
    const context = captureOpenClawStateWorkerContext(options);
    const location = { context, location: pathname, checkFreshAdmission: false };
    const authority = { signal: new AbortController().signal, assertCurrent: () => {} };
    const expected = { ...input };
    const command = { type: "audit.run.inspect" as const, input };
    const transport = createOpenClawStateReadTransport(command);
    const baseline = createOpenClawStateReadTransport({ type: "fleet.list" });
    // The caller can mutate its input while the owner prepares a read location.
    input.now = 999;
    input.decisionCursor = "changed before read";
    input.decisionLimit = 99;
    if ("executionId" in input) {
      input.executionId = "changed execution";
    } else {
      input.runId = "changed run";
      input.executionOffset = 99;
      input.executionLimit = 99;
    }
    const dispatch = createDeferredCore();
    const baselineTask = queueTask(dispatch.promise);
    const task = queueTask(dispatch.promise);
    const baselineRead = baseline.read(location, authority);
    const read = transport.read(location, authority);
    // A pre-admission failure must surface directly rather than leave this test waiting for dispatch.
    const submitted = Promise.race([
      task.submitted,
      read.then(() => {
        throw new Error("Read completed before dispatch");
      }),
    ]);
    try {
      const [baselineOptions, auditOptions] = await Promise.all([
        baselineTask.submitted,
        submitted,
      ]);
      const selector = "executionId" in expected ? expected.executionId : expected.runId;
      const additionalBytes =
        Buffer.byteLength("audit.run.inspect") -
        Buffer.byteLength("fleet.list") +
        Buffer.byteLength(selector) +
        Buffer.byteLength(expected.decisionCursor ?? "") +
        numericBytes;
      expect(auditOptions.inputBytes).toBe(Number(baselineOptions.inputBytes) + additionalBytes);
      input.now = 1234;
      input.decisionCursor = "changed while queued";
      dispatch.resolve();
      const request = await task.captured;
      expect(request.command).toEqual({ type: "audit.run.inspect", input: expected });
      baselineTask.result.resolve(emptyReply);
      task.result.resolve(emptyReply);
      await Promise.all([baselineRead, read]);
    } finally {
      dispatch.resolve();
      baselineTask.result.resolve(emptyReply);
      task.result.resolve(emptyReply);
      await Promise.allSettled([baselineRead, read]);
      await Promise.all([baseline.close(), transport.close()]);
    }
  },
);

it("captures and charges independent snapshot and schema paths before queued dispatch", async () => {
  const { root, options } = source();
  const context = { ...captureOpenClawStateWorkerContext(options), existingSchemaPath: undefined };
  const existingSchemaPath = path.join(root, "canonical-schema-根🦞.sqlite");
  const snapshotRoot = path.join(root, "snapshot-根🦞");
  const location = path.join(snapshotRoot, "nested", "reader.sqlite");
  const sourceLocation = { context, location, checkFreshAdmission: true, snapshotRoot };
  const schemaLocation = {
    ...sourceLocation,
    context: { ...context, existingSchemaPath },
  };
  const controller = new AbortController();
  const authority = {
    signal: controller.signal,
    assertCurrent() {
      controller.signal.throwIfAborted();
      context.admission.assertCurrent();
    },
  };
  const dispatch = createDeferredCore();
  const baselineTask = queueTask(dispatch.promise);
  const rootedTask = queueTask(dispatch.promise);
  const schemaTask = queueTask(dispatch.promise);
  const baseline = createOpenClawStateReadTransport({ type: "fleet.list" });
  const rooted = createOpenClawStateReadTransport({ type: "fleet.list" });
  const schema = createOpenClawStateReadTransport({ type: "fleet.list" });
  const baselineRead = baseline.read({ ...sourceLocation, snapshotRoot: undefined }, authority);
  const rootedRead = rooted.read(sourceLocation, authority);
  const schemaRead = schema.read(schemaLocation, authority);
  try {
    const [baselineOptions, rootedOptions, schemaOptions] = await Promise.all([
      baselineTask.submitted,
      rootedTask.submitted,
      schemaTask.submitted,
    ]);
    const baselineBytes = baselineOptions.inputBytes;
    const rootedBytes = rootedOptions.inputBytes;
    const schemaBytes = schemaOptions.inputBytes;
    expect(Number.isSafeInteger(baselineBytes)).toBe(true);
    expect(Number.isSafeInteger(rootedBytes)).toBe(true);
    expect(Number.isSafeInteger(schemaBytes)).toBe(true);
    if (
      typeof baselineBytes !== "number" ||
      typeof rootedBytes !== "number" ||
      typeof schemaBytes !== "number"
    ) {
      throw new Error("Captured worker requests must carry byte admission");
    }
    // Each independently retained path must add at least its own UTF-8 payload.
    expect(rootedBytes).toBeGreaterThanOrEqual(baselineBytes + Buffer.byteLength(snapshotRoot));
    expect(schemaBytes).toBeGreaterThanOrEqual(rootedBytes + Buffer.byteLength(existingSchemaPath));
    sourceLocation.snapshotRoot = path.join(root, "replacement-root");
    sourceLocation.location = path.join(root, "replacement.sqlite");
    schemaLocation.context.existingSchemaPath = path.join(root, "replacement-schema.sqlite");
    dispatch.resolve();
    const [unrootedRequest, rootedRequest, schemaRequest] = await Promise.all([
      baselineTask.captured,
      rootedTask.captured,
      schemaTask.captured,
    ]);
    expect(unrootedRequest.snapshotRoot).toBeUndefined();
    expect(rootedRequest).toMatchObject({ location, snapshotRoot, checkFreshAdmission: true });
    expect(rootedRequest.snapshotRoot).not.toBe(path.dirname(rootedRequest.location));
    expect(schemaRequest).toMatchObject({
      context: { existingSchemaPath },
      location,
      snapshotRoot,
      checkFreshAdmission: true,
    });
    baselineTask.result.resolve(emptyReply);
    rootedTask.result.resolve(emptyReply);
    schemaTask.result.resolve(emptyReply);
    await expect(baselineRead).resolves.toEqual({ value: emptyReply });
    await expect(rootedRead).resolves.toEqual({ value: emptyReply });
    await expect(schemaRead).resolves.toEqual({ value: emptyReply });
  } finally {
    dispatch.resolve();
    baselineTask.result.resolve(emptyReply);
    rootedTask.result.resolve(emptyReply);
    schemaTask.result.resolve(emptyReply);
    await Promise.allSettled([baselineRead, rootedRead, schemaRead]);
    await Promise.all([baseline.close(), rooted.close(), schema.close()]);
  }
});
