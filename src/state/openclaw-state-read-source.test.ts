// Register the existing pool fixture before importing its consumers.
// oxfmt-ignore
import { emptyReply, mock, queueTask, source } from "./openclaw-state-read-worker.test-harness.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { withRuntimeWorkerGeneration } from "../infra/runtime-worker-generation.js";
import { captureRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runOpenClawAgentWriteAdmission } from "./openclaw-agent-write-admission.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import {
  captureOpenClawStateReadSource,
  retireIdleOpenClawStateReadWorkers,
} from "./openclaw-state-read-worker.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

it("retires cached readers after independent custody joins and permits reuse", async () => {
  const { options } = source();
  const nativeSource = captureRetainedNativeWorkerSource();
  const task = queueTask();
  const reading = executeExistingOpenClawStateRead(options, { type: "backup.runs" });
  try {
    await task.captured;
    expect(await retireIdleOpenClawStateReadWorkers(nativeSource)).toBe(false);
    expect(mock.closePool).not.toHaveBeenCalled();
  } finally {
    task.result.resolve(emptyReply);
    await reading;
  }
  expect(mock.closePool).not.toHaveBeenCalled();
  expect(await retireIdleOpenClawStateReadWorkers(nativeSource)).toBe(true);
  expect(mock.closePool).toHaveBeenCalledOnce();

  const next = queueTask();
  next.result.resolve(emptyReply);
  await expect(executeExistingOpenClawStateRead(options, { type: "backup.runs" })).resolves.toEqual(
    emptyReply,
  );
  expect(mock.create).toHaveBeenCalledTimes(2);
});

it.each([true, false])(
  "refuses writer-held reader retirement before cleanup (targeted close: %s)",
  async (explicitSqliteCloseReleasesNativeResources) => {
    const { options } = source();
    mock.capabilities.mockReturnValue({
      explicitSqliteCloseReleasesNativeResources,
      decided: true,
      reason: "test policy",
    });
    const nativeSource = captureRetainedNativeWorkerSource();
    queueTask().result.resolve(emptyReply);
    await executeExistingOpenClawStateRead(options, { type: "backup.runs" });

    await expect(
      runOpenClawAgentWriteAdmission({ agentId: "main", path: options.path }, () =>
        retireIdleOpenClawStateReadWorkers(nativeSource),
      ),
    ).rejects.toThrow("while holding a store writer");
    expect(mock.closeResources).not.toHaveBeenCalled();
    expect(mock.rotate).not.toHaveBeenCalled();
    expect(mock.closePool).not.toHaveBeenCalled();

    await expect(retireIdleOpenClawStateReadWorkers(nativeSource)).resolves.toBe(true);
    expect(
      explicitSqliteCloseReleasesNativeResources ? mock.closeResources : mock.rotate,
    ).toHaveBeenCalledOnce();
    expect(mock.closePool).toHaveBeenCalledOnce();
  },
);

it("keeps lazy reads with their captured generation when another generation dispatches them", async () => {
  const { options } = source();
  const context = captureOpenClawStateWorkerContext(options);
  const location = { context, location: options.path, checkFreshAdmission: false };
  const authority = { signal: new AbortController().signal, assertCurrent: () => {} };
  const moduleUrl = resolveRuntimeProcessEntrypointUrl("stateRead");
  const firstUrl = new URL("file:///synthetic/first/state-reader.mjs");
  const secondUrl = new URL("file:///synthetic/second/state-reader.mjs");
  await withRuntimeWorkerGeneration(
    async (bindFirst) => {
      bindFirst((url) => (url.href === moduleUrl.href ? firstUrl : url));
      const first = captureOpenClawStateReadSource();
      expect(mock.create).not.toHaveBeenCalled();
      expect(mock.selectSqlite).not.toHaveBeenCalled();
      await withRuntimeWorkerGeneration(
        async (bindSecond) => {
          bindSecond((url) => (url.href === moduleUrl.href ? secondUrl : url));
          const second = captureOpenClawStateReadSource();
          const firstTask = queueTask();
          const secondTask = queueTask();
          firstTask.result.resolve(emptyReply);
          secondTask.result.resolve(emptyReply);
          const firstTransport = first.createTransport({ type: "backup.runs" });
          const secondTransport = second.createTransport({ type: "backup.runs" });
          try {
            await expect(firstTransport.startRead(location, authority).result).resolves.toEqual({
              value: emptyReply,
            });
            await expect(secondTransport.startRead(location, authority).result).resolves.toEqual({
              value: emptyReply,
            });
            expect(mock.create).toHaveBeenCalledTimes(2);
            expect(mock.create).toHaveBeenNthCalledWith(
              1,
              expect.objectContaining({ workerUrl: firstUrl }),
              expect.objectContaining({ retainedTransport: true }),
            );
            expect(mock.create).toHaveBeenNthCalledWith(
              2,
              expect.objectContaining({ workerUrl: secondUrl }),
              expect.objectContaining({ retainedTransport: true }),
            );
          } finally {
            await Promise.all([
              firstTransport.startClose().result,
              secondTransport.startClose().result,
            ]);
          }
        },
        async () => {},
      );
    },
    async () => {},
  );
});

it("joins captured domain cleanup before retiring its pool and execution generation", async () => {
  const { options } = source();
  const context = captureOpenClawStateWorkerContext(options);
  const scope = new AsyncLocalStorage<string>();
  const ownerCloseStarted = createDeferredCore();
  const ownerMayClose = createDeferredCore();
  const events: string[] = [];
  const releaseGeneration = vi.fn(async () => {
    events.push("generation released");
  });
  mock.closeResources.mockImplementation(async () => {
    events.push("resources closed");
  });
  mock.closePool.mockImplementation(async () => {
    events.push("pool closed");
  });
  let captured: ReturnType<typeof captureOpenClawStateReadSource> | undefined;
  const generation = withRuntimeWorkerGeneration(async (bind) => {
    bind((url) => new URL(`${url.href}?synthetic-generation=owned`));
    captured = captureOpenClawStateReadSource();
    const retainedSource = captured;
    const transport = retainedSource.createTransport({ type: "backup.runs" });
    const task = queueTask();
    task.result.resolve(emptyReply);
    scope.run("accepted reader", () => {
      const unregister = retainedSource.own(
        () => {
          expect(scope.getStore()).toBe("accepted reader");
          events.push("reader serviced");
          retainedSource.service();
        },
        async () => {
          expect(scope.getStore()).toBe("accepted reader");
          events.push("domain closing");
          ownerCloseStarted.resolve();
          await ownerMayClose.promise;
          await transport.startRead(
            { context, location: options.path, checkFreshAdmission: false },
            { signal: new AbortController().signal, assertCurrent: () => {} },
          ).result;
          await transport.startClose().result;
          unregister();
          events.push("domain closed");
        },
      );
    });
    scope.run("later reader", () => retainedSource.service());
  }, releaseGeneration);
  try {
    await Promise.race([
      ownerCloseStarted.promise,
      generation.then(() => {
        throw new Error("Generation completed before domain cleanup");
      }),
    ]);
    expect(events).toEqual(["reader serviced", "domain closing"]);
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.closePool).not.toHaveBeenCalled();
    expect(releaseGeneration).not.toHaveBeenCalled();
    expect(() =>
      captured?.own(
        () => {},
        async () => {},
      ),
    ).toThrow(/closing/);
  } finally {
    ownerMayClose.resolve();
    await generation;
  }
  expect(events).toEqual([
    "reader serviced",
    "domain closing",
    "domain closed",
    "resources closed",
    "pool closed",
    "generation released",
  ]);
});

it.each(["workerPlacements.changeSnapshot", "cron.activeReceiptOwners"] as const)(
  "captures and charges selectors before queued dispatch (%s)",
  async (type) => {
    const { pathname, options } = source();
    const selector = "选择🦞".repeat(512);
    const command =
      type === "workerPlacements.changeSnapshot"
        ? { type, profileIds: [selector, selector] }
        : { type, agentId: selector };
    const expected = structuredClone(command);
    const transport = captureOpenClawStateReadSource().createTransport(command);
    if (command.type === "workerPlacements.changeSnapshot") {
      command.profileIds.splice(0);
    } else {
      command.agentId = "different agent before preparation";
    }
    const dispatch = createDeferredCore();
    const task = queueTask(dispatch.promise);
    const read = transport.startRead(
      {
        context: captureOpenClawStateWorkerContext(options),
        location: pathname,
        checkFreshAdmission: false,
      },
      { signal: new AbortController().signal, assertCurrent: () => {} },
    ).result;
    try {
      const submitted = await task.submitted;
      dispatch.resolve();
      expect.soft((await task.captured).command).toEqual(expected);
      expect
        .soft(submitted.inputBytes)
        .toBeGreaterThanOrEqual(
          Buffer.byteLength(selector) * (type === "workerPlacements.changeSnapshot" ? 2 : 1),
        );
    } finally {
      dispatch.resolve();
      task.result.resolve(
        type === "workerPlacements.changeSnapshot"
          ? { ok: true, type, sourceAdmitted: true, placements: [] }
          : { ok: true, type, sourceAdmitted: true, owners: [] },
      );
      await read;
      await transport.startClose().result;
    }
  },
);
