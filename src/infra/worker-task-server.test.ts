import { EventEmitter } from "node:events";
import { MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SqliteDatabaseAdmissions } from "./sqlite-database-admission-record.js";
import { expectCalls } from "./worker-task-pool.owned.test-support.js";
import type { WorkerTaskContext } from "./worker-task-transport.js";

const boundary = vi.hoisted(() => {
  const port: unknown = undefined;
  return { port, closeMemory: vi.fn(), environment: new Map<unknown, unknown>() };
});
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  get parentPort() {
    return boundary.port;
  },
  getEnvironmentData: (key: unknown) => boundary.environment.get(key),
  setEnvironmentData: (key: unknown, value: unknown) => boundary.environment.set(key, value),
}));
// mock-isolation: Each synthetic worker gets isolate-local registries, not the test process's state.
vi.mock("../shared/global-singleton.js", () => ({
  resolveGlobalSingleton: <T>(_key: symbol, create: () => T): T => create(),
  resolveGlobalMap: <K, V>() => new Map<K, V>(),
  resolveGlobalSet: <T>() => new Set<T>(),
  readGlobalSingleton: () => undefined,
  drainGlobalSingletonLifecycleState: async () => {},
}));
// mock-isolation: Do not initialize process-wide logging for the worker protocol fixture.
vi.mock("../logging/state.js", () => ({ loggingState: {} }));
// mock-isolation: Admission imports publication diagnostics, not the logging/config runtime.
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ error: vi.fn() }),
}));
// mock-isolation: Observe diagnostic cleanup without allocating a memory transport.
vi.mock("./worker-memory.js", () => ({
  serveWorkerMemorySamples: () => ({
    close: boundary.closeMemory,
    setTaskMetrics: () => {},
    collectTask: () => undefined,
  }),
}));
// mock-isolation: Keep process-wide idle timers outside the retirement fixture.
vi.mock("./worker-idle-gc.js", () => ({
  cancelWorkerIdleGc: vi.fn(),
  scheduleWorkerIdleGc: vi.fn(),
}));
const exitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  boundary.closeMemory.mockReset();
  boundary.environment.clear();
});
afterEach(() => {
  process.exitCode = exitCode;
});

function taskContext(databaseAdmissionPort?: MessagePort): WorkerTaskContext {
  return { deletedAgentDatabaseFences: [], databaseAdmissionPort };
}

function resourceReceipt() {
  const closed = createDeferred();
  return { postMessage: vi.fn(), close: vi.fn(() => closed.resolve()), closed: closed.promise };
}

async function admissionFixture() {
  const { port1: port, port2: peer } = new MessageChannel();
  onTestFinished(() => {
    port.close();
    peer.close();
  });
  const { hasSqliteDatabaseSchemaAdmissionForPath: admit } =
    await import("./sqlite-database-admission.js");
  const { getSqliteDatabaseAdmissionUpstream: upstream } =
    await import("./sqlite-worker-database-admission-relay.js");
  return {
    port,
    peer,
    upstream,
    close: vi.spyOn(port, "close"),
    // Reply before publishing completion so synchronous native admission needs no worker or timer.
    exchanges: vi.spyOn(port, "postMessage").mockImplementation((message: unknown) => {
      // SAFETY: Only the production admission relay writes this private fixture port.
      const request = message as {
        admissions: SqliteDatabaseAdmissions;
        port: MessagePort;
        decision: SharedArrayBuffer;
      };
      request.port.postMessage(request.admissions, []);
      Atomics.store(new Int32Array(request.decision), 0, 1);
    }),
    inspect: () => {
      admit(":memory:");
    },
  };
}

async function workerFixture() {
  let result = createDeferred<string>();
  const closed = createDeferred<string>();
  const port = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(() => result.resolve("result")),
    close: vi.fn(() => closed.resolve("closed")),
  });
  boundary.port = port;
  return {
    ...(await import("./worker-task-server.js")),
    port,
    closed: closed.promise,
    task(this: void, taskId: number, context = taskContext(), sampleMemory = false) {
      result = createDeferred<string>();
      port.emit("message", {
        taskId,
        nativeSections: new SharedArrayBuffer(4),
        taskContext: context,
        sampleMemory,
      });
      return result.promise;
    },
    expectResult(this: void, taskId: number, value: unknown) {
      expect(port.postMessage).toHaveBeenLastCalledWith(
        { status: "ok", value, taskId, diagnostics: undefined },
        [],
      );
    },
  };
}

it.each([false, true])(
  "joins task cleanup and queued receipts before retiring admission transport (diagnostic failure: %s)",
  async (diagnosticFailure) => {
    const { port, task, closed, serveOwnedWorkerTasks } = await workerFixture();
    const entered = createDeferred();
    const cleanup = createDeferred();
    const admission = await admissionFixture();
    const closeResource = vi.fn();
    const handler = vi.fn(async () => {
      entered.resolve();
      await cleanup.promise;
      admission.inspect();
      throw new Error("uncertain native close");
    });
    const receipt = resourceReceipt();
    boundary.closeMemory.mockImplementation(() => {
      if (diagnosticFailure) {
        throw new Error("memory diagnostic cleanup failed");
      }
    });
    try {
      serveOwnedWorkerTasks(handler, { retireOnError: true, closeResource });
      const result = task(1, taskContext(admission.port), true);
      await entered.promise;
      expect(admission.upstream()).toEqual({ port: admission.port, closed: false });
      port.emit("message", { closeResource: true, resourcePort: receipt });
      expectCalls(0, port.close, admission.close, boundary.closeMemory);
      expect(process.exitCode).toBe(exitCode);
      cleanup.resolve();
      expect(await Promise.race([closed, result])).toBe("closed");
      expectCalls(1, admission.exchanges, receipt.close);
      expectCalls(1, boundary.closeMemory, admission.close, port.close);
      expect(receipt.postMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: false }), []);
      expectCalls(0, closeResource);
      expect(receipt.close).toHaveBeenCalledBefore(boundary.closeMemory);
      expect(boundary.closeMemory).toHaveBeenCalledBefore(admission.close);
      expect(admission.close).toHaveBeenCalledBefore(port.close);
      expect(process.exitCode).toBe(1);
      port.emit("message", { taskId: 2 });
      expectCalls(1, handler);
      expectCalls(0, port.postMessage);
    } finally {
      cleanup.resolve();
    }
  },
);

it("retains admission context for asynchronous resource cleanup and successor tasks", async () => {
  const { port, task, serveOwnedWorkerTasks } = await workerFixture();
  const cleanupEntered = createDeferred();
  const finishCleanup = createDeferred();
  const admission = await admissionFixture();
  const { registerAgentDatabaseReaderCloser, isDeletedAgentDatabasePath } =
    await import("./agent-database-readers.js");
  const unregister = registerAgentDatabaseReaderCloser(async () => {
    cleanupEntered.resolve();
    await finishCleanup.promise;
    admission.inspect();
  });
  const closeResource = vi.fn(admission.inspect);
  const handler = vi.fn(admission.inspect);
  const receipt = resourceReceipt();
  try {
    serveOwnedWorkerTasks(handler, { closeResource });
    await task(1, {
      ...taskContext(admission.port),
      deletedAgentDatabaseFences: [["/synthetic/retired-agent.sqlite", "retired-agent"]],
    });
    expect(isDeletedAgentDatabasePath("/synthetic/retired-agent.sqlite")).toBe(true);
    expectCalls(1, admission.exchanges);
    port.emit("message", { closeResource: true, key: "[]", resourcePort: receipt });
    await cleanupEntered.promise;
    expectCalls(0, receipt.postMessage, admission.close);
    const result = task(2);
    expect(handler).toHaveBeenCalledOnce();
    finishCleanup.resolve();
    await receipt.closed;
    await result;
    expect(receipt.postMessage).toHaveBeenCalledWith({ ok: true }, []);
    expect(closeResource).toHaveBeenCalledExactlyOnceWith("[]");
    expect(handler).toHaveBeenCalledTimes(2);
    expectCalls(4, admission.exchanges);
    expect(admission.upstream()).toEqual({ port: admission.port, closed: false });
    expect(isDeletedAgentDatabasePath("/synthetic/retired-agent.sqlite")).toBe(false);
    admission.peer.postMessage("still open", []);
    expect(receiveMessageOnPort(admission.port)?.message).toBe("still open");
    expectCalls(0, admission.close, port.close);
    expect(process.exitCode).toBe(exitCode);
  } finally {
    finishCleanup.resolve();
    unregister();
  }
});

it("expires a task's admission budget without poisoning its successor or resource cleanup", async () => {
  const { port, task, expectResult, serveOwnedWorkerTasks } = await workerFixture();
  const admission = await admissionFixture();
  const receipt = resourceReceipt();
  const handler = vi.fn(() => {
    admission.inspect();
    return "next task";
  });
  serveOwnedWorkerTasks(handler, { closeResource: admission.inspect });
  await task(1, {
    ...taskContext(admission.port),
    databaseAdmissionDeadlineAtMs: Date.now() - 1,
  });
  expect(port.postMessage).toHaveBeenCalledWith(
    {
      status: "failed",
      taskId: 1,
      error: "SQLite admission facts exchange timed out; the host did not reply",
      diagnostics: undefined,
    },
    [],
  );
  expectCalls(0, admission.exchanges);
  port.emit("message", { closeResource: true, resourcePort: receipt });
  await receipt.closed;
  expect(receipt.postMessage).toHaveBeenCalledWith({ ok: true }, []);
  await task(2);
  expectResult(2, "next task");
  expectCalls(2, admission.exchanges, handler);
  expectCalls(0, port.close, boundary.closeMemory);
  expect(process.exitCode).toBe(exitCode);
});

it.each([undefined, "openclaw doctor --fix"])(
  "settles encoded service failures through the owning lifecycle (next step: %s)",
  async (nextStep) => {
    const { port, task, closed, serveOwnedWorkerTasks } = await workerFixture();
    const { bindPostgresPool, recordPostgresPoolFailure } = await import("./postgres-sync/pool.js");
    const { port1, port2 } = new MessageChannel();
    onTestFinished(() => {
      port1.close();
      port2.close();
    });
    bindPostgresPool({
      allocation: new SharedArrayBuffer(4),
      services: [{ port: port1, signal: new SharedArrayBuffer(8) }],
      nextStep,
    });
    const error = new Error(
      `PostgreSQL connection lost; outcome unknown${nextStep ? `. Run ${nextStep}.` : ""}`,
    );
    const result = { ok: false, error: error.message };
    serveOwnedWorkerTasks(() => {
      recordPostgresPoolFailure(error);
      return result;
    });
    expect(await Promise.race([task(1), closed])).toBe(nextStep ? "result" : "closed");
    if (nextStep) {
      expect(port.postMessage).toHaveBeenCalledWith(
        { status: "ok", taskId: 1, value: result, diagnostics: undefined },
        [],
      );
      expect(port.close).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(exitCode);
    } else {
      expect(port.postMessage).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    }
  },
);
