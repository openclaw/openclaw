// Register shared pool mocks before modules that consume them.
// oxfmt-ignore
import { emptyReply, mock, queueTask, source, tempDirs } from "./openclaw-state-read-worker.test-harness.js";
import fs from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import { withExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateReadSource } from "./openclaw-state-read-worker.js";
import type { OpenClawStateReadReply } from "./openclaw-state-read.types.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

it.each(["complete", "cancel", "revoke", "worker-failure"] as const)(
  "joins asynchronous stream consumption before releasing its reader (%s)",
  async (finish) => {
    const { options } = source();
    const context = captureOpenClawStateWorkerContext(options);
    const controller = new AbortController();
    const taskController = new AbortController();
    const failure = new Error(`stream ${finish}`);
    let current = true;
    const authority = {
      signal: controller.signal,
      assertCurrent() {
        controller.signal.throwIfAborted();
        if (!current) {
          throw failure;
        }
        context.admission.assertCurrent();
      },
    };
    const consumed = createDeferredCore();
    let chunkSignal: AbortSignal | undefined;
    const onChunkAsync = vi.fn(async (value: unknown, signal: AbortSignal) => {
      expect(value).toEqual(["bounded row"]);
      expect(signal.aborted).toBe(false);
      chunkSignal = signal;
      if (finish === "worker-failure") {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } else {
        await consumed.promise;
      }
    });
    const task = createRetainedOperation<OpenClawStateReadReply>(() => {});
    const released = createRetainedOperation<void>(() => {});
    released.resolve(undefined);
    mock.runTask.mockReturnValueOnce({ ...task.operation, release: () => released.operation });
    const transport = captureOpenClawStateReadSource().createTransport(
      { type: "backup.runs" },
      undefined,
      onChunkAsync,
    );
    const reading = transport.startRead(
      { context, location: options.path, checkFreshAdmission: false },
      authority,
    );
    const request = mock.runTask.mock.calls[0]?.[1].onRequest;
    if (!request) {
      throw new Error("Stream reader did not admit asynchronous consumption");
    }
    const response = request(["bounded row"], {
      signal: taskController.signal,
      yieldSignal: new AbortController().signal,
    });
    const responseAssertion =
      finish === "complete"
        ? expect(response).resolves.toMatchObject({ input: null })
        : finish === "worker-failure"
          ? expect(response).rejects.toMatchObject({ name: "AbortError" })
          : expect(response).rejects.toBe(failure);
    try {
      expect(onChunkAsync).toHaveBeenCalledOnce();
      if (finish === "cancel") {
        controller.abort(failure);
      } else if (finish === "revoke") {
        current = false;
      } else if (finish === "worker-failure") {
        taskController.abort();
        task.reject(failure);
        expect(chunkSignal?.aborted).toBe(true);
        expect(controller.signal.aborted).toBe(false);
        expect(() => authority.assertCurrent()).not.toThrow();
      }
      const closing = transport.startClose();
      closing.service();
      expect(closing.read()).toEqual({ status: "pending" });
      if (finish !== "worker-failure") {
        consumed.resolve();
      }
      await responseAssertion;
      await closing.result;
      if (finish === "worker-failure") {
        await expect(reading.result).resolves.toEqual({ error: failure });
        expect(controller.signal.aborted).toBe(false);
      }
      expect(onChunkAsync).toHaveBeenCalledOnce();
      expect(mock.runTask).toHaveBeenCalledOnce();
    } finally {
      controller.abort(failure);
      consumed.resolve();
      task.resolve(emptyReply);
      await Promise.allSettled([responseAssertion, reading.result, transport.startClose().result]);
    }
  },
);

it("captures queued read routing and schema facts without reading unrelated environment values", async () => {
  const { root, pathname } = source();
  let unrelatedReads = 0;
  const env: NodeJS.ProcessEnv = {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_SUPERVISOR_MODE: " EXTERNAL ",
    get UNRELATED_INITIALIZATION_VALUE() {
      unrelatedReads += 1;
      return "synthetic initializer input";
    },
  };
  const dispatch = createDeferredCore();
  const task = queueTask(dispatch.promise);
  const result = withExistingOpenClawStateSchema({ path: pathname }, () =>
    executeExistingOpenClawStateRead({ path: pathname, env }, { type: "backup.runs" }),
  );
  try {
    expect((await task.submitted).diagnosticOperation).toBe("backup.runs");
    env.OPENCLAW_STATE_DIR = path.join(root, "changed-after-capture");
    env.OPENCLAW_SUPERVISOR_MODE = "internal";
    dispatch.resolve();
    const request = await task.captured;
    expect(request.context.environment).toEqual({
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_SUPERVISOR_MODE: "external",
    });
    expect(request.context.existingSchemaPath).toBe(pathname);
    // Windows captures case-insensitive environment semantics before selecting these facts.
    if (process.platform !== "win32") {
      expect(unrelatedReads).toBe(0);
    }
    task.result.resolve(emptyReply);
    await expect(result).resolves.toEqual(emptyReply);
  } finally {
    dispatch.resolve();
    task.result.resolve(emptyReply);
    await Promise.allSettled([result]);
  }
});

it("lets an active reader's host callback finish a nested read before the parent settles", async () => {
  const { pathname, options } = source();
  if (threadId === 0) {
    // Native hosts publish real admission; raw Worker hosts intentionally retain native checks.
    fs.unlinkSync(pathname);
    openOpenClawStateDatabase(options);
  }
  const context = captureOpenClawStateWorkerContext(options);
  const location = { context, location: pathname, checkFreshAdmission: false };
  const controller = new AbortController();
  const authority = { signal: controller.signal, assertCurrent: context.admission.assertCurrent };
  const firstTask = queueTask();
  const nestedTask = queueTask();
  const nestedTransport = captureOpenClawStateReadSource().createTransport({ type: "backup.runs" });
  let nested: Promise<unknown> | undefined;
  const transport = captureOpenClawStateReadSource().createTransport(
    { type: "backup.runs" },
    () => {
      nested = nestedTransport.startRead(location, authority).result;
    },
  );
  const parent = transport.startRead(location, authority).result;
  try {
    const submitted = await firstTask.submitted;
    await firstTask.captured;
    if (!submitted.onRequestSync) {
      throw new Error("Reader callback was not installed");
    }
    submitted.onRequestSync("synthetic chunk", {
      signal: controller.signal,
      yieldSignal: controller.signal,
    });
    await nestedTask.captured;
    nestedTask.result.resolve(emptyReply);
    await expect(nested).resolves.toEqual({ value: emptyReply });
    firstTask.result.resolve(emptyReply);
    await expect(parent).resolves.toEqual({ value: emptyReply });
  } finally {
    firstTask.result.resolve(emptyReply);
    nestedTask.result.resolve(emptyReply);
    await Promise.allSettled([parent, nested]);
    await Promise.all([transport.startClose().result, nestedTransport.startClose().result]);
  }
});

it("preserves task and cleanup errors across explicit retirement retries", async () => {
  const { pathname, options } = source();
  const task = queueTask();
  const original = new Error("original worker task failed");
  const retirement = new Error("first worker stop failed");
  const retryFailure = new Error("second worker stop failed");
  task.close.mockRejectedValueOnce(retirement);
  task.close.mockRejectedValueOnce(retryFailure);
  const result = executeExistingOpenClawStateRead(options, { type: "backup.runs" });
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
  await expect(closeOpenClawStateDatabaseByPathAsync(pathname)).rejects.toBe(retryFailure);
  expect(task.close).toHaveBeenCalledTimes(2);
  await closeOpenClawStateDatabaseByPathAsync(pathname);
  expect(task.close).toHaveBeenCalledTimes(3);
  await closeOpenClawStateDatabaseByPathAsync(pathname);
  expect(task.close).toHaveBeenCalledTimes(3);
  expect(mock.closePool).not.toHaveBeenCalled();
  expect(mock.runTask).toHaveBeenCalledOnce();
  await expect(result).rejects.toMatchObject({ cause: original, errors: [original, retirement] });
});

it("reads externally created state after an absent read without allocating a worker first", async () => {
  const root = tempDirs.make("openclaw-read-first-creation-");
  const pathname = path.join(root, "source.sqlite");
  const options = { path: pathname, env: { OPENCLAW_STATE_DIR: root } };
  const command = { type: "backup.runs" } as const;
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

it("retires a successful read without hydrating an error and retains custody until exit", async () => {
  const { options } = source();
  const hydrate = vi.spyOn(
    await import("./openclaw-state-worker-error.js"),
    "hydrateOpenClawStateWorkerError",
  );
  const task = queueTask();
  const stopping = createDeferredCore();
  const stopped = createDeferredCore();
  task.close.mockImplementationOnce(() => {
    stopping.resolve();
    return stopped.promise;
  });
  const reply: OpenClawStateReadReply = {
    ...emptyReply,
    nativeCleanupFailure: { error: undefined },
  };
  const result = executeExistingOpenClawStateRead(options, { type: "backup.runs" });
  const assertion = expect(result).resolves.toMatchObject({
    ok: true,
    type: "backup.runs",
    runs: [],
  });
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  void result.then(markSettled, markSettled);
  try {
    await task.captured;
    task.result.resolve(reply);
    await stopping.promise;
    expect(task.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
    expect(mock.selectSqlite).toHaveBeenCalledOnce();
    expect(mock.selectSqlite.mock.invocationCallOrder[0]).toBeLessThan(
      mock.create.mock.invocationCallOrder[0]!,
    );
    expect(settled).toBe(false);
    expect(hydrate).not.toHaveBeenCalled();
    expect(mock.closePool).not.toHaveBeenCalled();
  } finally {
    task.result.resolve(reply);
    stopped.resolve();
    try {
      await assertion;
    } finally {
      hydrate.mockRestore();
    }
  }
  expect(task.close).toHaveBeenCalledOnce();
});

it("preserves source and worker stop failures when native cleanup fails", async () => {
  const { pathname, options } = source();
  const task = queueTask();
  const primary = new Error("source query failed");
  const stop = new Error("worker native exit not confirmed");
  task.close.mockRejectedValueOnce(stop);
  const result = executeExistingOpenClawStateRead(options, { type: "backup.runs" });
  const outcome = result.catch((error: unknown) => error);
  await task.captured;
  const reply: OpenClawStateReadReply = {
    ok: false,
    sourceAdmitted: true,
    message: primary.message,
    error: encodeOpenClawStateWorkerError(primary, { includeOrdinary: true }),
  };
  task.result.resolve({
    ...reply,
    nativeCleanupFailure: {
      error: undefined,
    },
  });
  const failure = await outcome;
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) {
    throw new Error("Read cleanup did not retain its error graph");
  }
  expect(failure.cause).toBe(failure.errors[0]);
  expect(failure.errors).toHaveLength(2);
  expect(failure.cause).toMatchObject({ message: primary.message });
  expect(failure.errors[1]).toBe(stop);
  expect(task.close).toHaveBeenCalledExactlyOnceWith({ retire: true });
  expect(mock.closePool).not.toHaveBeenCalled();

  await closeOpenClawStateDatabaseByPathAsync(pathname);
  expect(task.close).toHaveBeenCalledTimes(2);
  await expect(result).rejects.toBe(failure);
});

it("closes one read path without aborting its sibling", async () => {
  const firstSource = source("first.sqlite");
  const siblingSource = source("sibling.sqlite");
  const first = queueTask();
  const sibling = queueTask();
  const firstRead = executeExistingOpenClawStateRead(firstSource.options, {
    type: "backup.runs",
  });
  const assertion = expect(firstRead).rejects.toThrow(/read admission (?:is )?closed/i);
  const siblingRead = executeExistingOpenClawStateRead(siblingSource.options, {
    type: "backup.runs",
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
  expect(sibling.close).toHaveBeenCalledExactlyOnceWith(undefined);
  await closeOpenClawStateDatabaseAsync();
  expect(mock.closePool).toHaveBeenCalledOnce();
});

it("captures reconciliation selectors and byte charges before queued dispatch", async () => {
  const { options } = source();
  const input = {
    runIds: ["更新🦞".repeat(512), "修复🦞".repeat(512)],
    explicit: true,
    requireAllActive: false,
    legacyOnly: true,
    repairHistorySinceMs: 0,
  };
  const command = { type: "updateRuns.reconciliationCandidates", input } as const;
  const reply: OpenClawStateReadReply = {
    ok: true,
    type: command.type,
    sourceAdmitted: true,
    candidates: [],
  };
  const expected = structuredClone(command);
  const originalRoot = options.env.OPENCLAW_STATE_DIR;
  const dispatch = createDeferredCore();
  const baselineTask = queueTask(dispatch.promise);
  const task = queueTask(dispatch.promise);
  const baseline = executeExistingOpenClawStateRead(options, { type: "backup.runs" });
  const result = executeExistingOpenClawStateRead(options, command);
  try {
    const [baselineOptions, submitted] = await Promise.all([
      baselineTask.submitted,
      Promise.race([
        task.submitted,
        result.then(() => {
          throw new Error("Read settled before queued dispatch");
        }),
      ]),
    ]);
    input.runIds[0] = "changed";
    input.runIds.push("added after admission");
    input.explicit = false;
    input.requireAllActive = true;
    input.legacyOnly = false;
    input.repairHistorySinceMs = 999;
    options.env.OPENCLAW_STATE_DIR = path.join(originalRoot, "different");
    expect(Number.isSafeInteger(submitted.inputBytes)).toBe(true);
    expect(submitted.inputBytes).toBeGreaterThanOrEqual(
      Number(baselineOptions.inputBytes) +
        Buffer.byteLength(expected.type) -
        Buffer.byteLength("backup.runs") +
        Buffer.byteLength("更新🦞修复🦞".repeat(512)) +
        11,
    );
    dispatch.resolve();
    await baselineTask.captured;
    baselineTask.result.resolve(emptyReply);
    const request = await task.captured;
    expect(request.command).toEqual(expected);
    expect(request.context.environment.OPENCLAW_STATE_DIR).toBe(originalRoot);
    task.result.resolve(reply);
    expect(await result).toEqual(reply);
    await baseline;
  } finally {
    dispatch.resolve();
    baselineTask.result.resolve(emptyReply);
    task.result.resolve(reply);
    await Promise.allSettled([baseline, result]);
  }
});
