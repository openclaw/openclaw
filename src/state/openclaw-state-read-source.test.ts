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

const backupRead = { type: "backup.runs" } as const;
function readyTask() {
  const task = queueTask();
  task.result.resolve(emptyReply);
  return task;
}

function withReadGeneration(
  workerUrl: URL,
  operation: (source: ReturnType<typeof captureOpenClawStateReadSource>) => Promise<void>,
) {
  const moduleUrl = resolveRuntimeProcessEntrypointUrl("stateRead");
  return withRuntimeWorkerGeneration(
    async (bind) => {
      bind((url) => (url.href === moduleUrl.href ? workerUrl : url));
      await operation(captureOpenClawStateReadSource());
    },
    async () => {},
  );
}

function readFixture() {
  const { options, pathname } = source();
  return {
    options,
    read: () => executeExistingOpenClawStateRead(options, backupRead),
    get location() {
      return {
        context: captureOpenClawStateWorkerContext(options),
        location: pathname,
        checkFreshAdmission: false,
      };
    },
    authority: { signal: new AbortController().signal, assertCurrent: () => {} },
  };
}

it("retires cached readers after independent custody joins and permits reuse", async () => {
  const { read } = readFixture();
  const nativeSource = captureRetainedNativeWorkerSource();
  const task = queueTask();
  const reading = read();
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

  readyTask();
  await expect(read()).resolves.toEqual(emptyReply);
  expect(mock.create).toHaveBeenCalledTimes(2);
});

it.each([true, false])(
  "refuses writer-held reader retirement before cleanup (targeted close: %s)",
  async (explicitSqliteCloseReleasesNativeResources) => {
    const { options, read } = readFixture();
    mock.capabilities.mockReturnValue({
      explicitSqliteCloseReleasesNativeResources,
      decided: true,
      reason: "test policy",
    });
    const nativeSource = captureRetainedNativeWorkerSource();
    readyTask();
    await read();

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
  const { location, authority } = readFixture();
  const firstUrl = new URL("file:///synthetic/first/state-reader.mjs");
  const secondUrl = new URL("file:///synthetic/second/state-reader.mjs");
  await withReadGeneration(firstUrl, async (first) => {
    expect(mock.create).not.toHaveBeenCalled();
    expect(mock.selectSqlite).not.toHaveBeenCalled();
    await withReadGeneration(secondUrl, async (second) => {
      const transports = [first, second].map((reader) => {
        readyTask();
        return reader.createTransport(backupRead);
      });
      try {
        for (const transport of transports) {
          await expect(transport.startRead(location, authority)).resolves.toEqual({
            value: emptyReply,
          });
        }
        expect(mock.create.mock.calls).toMatchObject(
          [firstUrl, secondUrl].map((workerUrl) => [{ workerUrl }, { retainedTransport: true }]),
        );
      } finally {
        await Promise.all(transports.map((transport) => transport.startClose()));
      }
    });
  });
});

it("joins captured domain cleanup before retiring its pool and execution generation", async () => {
  const { location, authority } = readFixture();
  const scope = new AsyncLocalStorage<string>();
  const ownerCloseStarted = createDeferredCore();
  const ownerMayClose = createDeferredCore();
  const events: string[] = [];
  const record = (event: string) => async () => {
    events.push(event);
  };
  const releaseGeneration = vi.fn(record("generation released"));
  mock.closeResources.mockImplementation(record("resources closed"));
  mock.closePool.mockImplementation(record("pool closed"));
  let captured: ReturnType<typeof captureOpenClawStateReadSource> | undefined;
  const generation = withRuntimeWorkerGeneration(async (bind) => {
    bind((url) => new URL(`${url.href}?synthetic-generation=owned`));
    captured = captureOpenClawStateReadSource();
    const retainedSource = captured;
    const transport = retainedSource.createTransport(backupRead);
    readyTask();
    scope.run("accepted reader", () => {
      const unregister = retainedSource.own(async () => {
        expect(scope.getStore()).toBe("accepted reader");
        events.push("domain closing");
        ownerCloseStarted.resolve();
        await ownerMayClose.promise;
        await transport.startRead(location, authority);
        await transport.startClose();
        unregister();
        events.push("domain closed");
      });
    });
  }, releaseGeneration);
  try {
    await Promise.race([
      ownerCloseStarted.promise,
      generation.then(() => {
        throw new Error("Generation completed before domain cleanup");
      }),
    ]);
    expect(events).toEqual(["domain closing"]);
    expect(mock.create).not.toHaveBeenCalled();
    expect(() => captured?.own(async () => {})).toThrow(/closing/);
  } finally {
    ownerMayClose.resolve();
    await generation;
  }
  expect(events).toEqual([
    "domain closing",
    "domain closed",
    "resources closed",
    "pool closed",
    "generation released",
  ]);
});

it.each(["workerPlacements.changeSnapshot", "agentDeletionJournal.status"] as const)(
  "captures and charges selectors before queued dispatch (%s)",
  async (type) => {
    const { location, authority } = readFixture();
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
    const read = transport.startRead(location, authority);
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
          : { ok: true, type, sourceAdmitted: true, status: "absent" },
      );
      await read;
      await transport.startClose();
    }
  },
);
