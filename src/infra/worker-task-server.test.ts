import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const boundary = vi.hoisted(() => {
  const port: unknown = undefined;
  return { port, closeMemory: vi.fn() };
});
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  get parentPort() {
    return boundary.port;
  },
}));
// mock-isolation: Do not initialize process-wide logging for the worker protocol fixture.
vi.mock("../logging/state.js", () => ({ loggingState: {} }));
// mock-isolation: Keep live database admission outside the synthetic task context.
vi.mock("./agent-database-readers.js", () => ({
  installDeletedAgentDatabaseFences: vi.fn(),
  decodeAgentDatabaseReaderRequest: () => undefined,
  applyAgentDatabaseReaderRequest: vi.fn(),
}));
// mock-isolation: Observe diagnostic cleanup without allocating a memory transport.
vi.mock("./worker-memory.js", () => ({ serveWorkerMemorySamples: () => boundary.closeMemory }));
// mock-isolation: Keep process-wide idle timers outside the retirement fixture.
vi.mock("./worker-idle-gc.js", () => ({
  cancelWorkerIdleGc: vi.fn(),
  scheduleWorkerIdleGc: vi.fn(),
}));
const exitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  boundary.closeMemory.mockClear();
});
afterEach(() => {
  process.exitCode = exitCode;
});

it("joins handler cleanup and queued resource receipts before terminal port closure", async () => {
  const closed = createDeferred<string>();
  const result = createDeferred<string>();
  const entered = createDeferred();
  const cleanup = createDeferred();
  const port = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(() => result.resolve("result")),
    close: vi.fn(() => closed.resolve("closed")),
  });
  boundary.port = port;
  const { serveOwnedWorkerTasks } = await import("./worker-task-server.js");
  const closeResource = vi.fn();
  const handler = vi.fn(async () => {
    try {
      throw new Error("uncertain native close");
    } finally {
      entered.resolve();
      await cleanup.promise;
    }
  });
  serveOwnedWorkerTasks(handler, { retireOnError: true, closeResource });
  port.emit("message", {
    taskId: 1,
    nativeSections: new SharedArrayBuffer(4),
    taskContext: [],
    sampleMemory: true,
  });
  await entered.promise;
  const receipt = { postMessage: vi.fn(), close: vi.fn() };
  port.emit("message", { closeResource: true, resourcePort: receipt });
  expect(port.close).not.toHaveBeenCalled();
  expect(boundary.closeMemory).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(exitCode);
  cleanup.resolve();
  expect(await Promise.race([closed.promise, result.promise])).toBe("closed");
  expect(receipt.postMessage).toHaveBeenCalledWith(expect.objectContaining({ ok: false }), []);
  expect(receipt.close).toHaveBeenCalledOnce();
  expect(closeResource).not.toHaveBeenCalled();
  expect(boundary.closeMemory).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(1);
  port.emit("message", { taskId: 2 });
  expect(handler).toHaveBeenCalledOnce();
  expect(port.postMessage).not.toHaveBeenCalled();
});

it("keeps ordinary task errors reusable", async () => {
  let result = createDeferred();
  const port = Object.assign(new EventEmitter(), {
    postMessage: vi.fn(() => result.resolve()),
    close: vi.fn(),
  });
  boundary.port = port;
  const { serveWorkerTasks } = await import("./worker-task-server.js");
  const handler = vi.fn<() => string>();
  handler.mockImplementationOnce(() => {
    throw new Error("ordinary failure");
  });
  handler.mockReturnValue("next task");
  serveWorkerTasks(handler);
  port.emit("message", {
    taskId: 1,
    nativeSections: new SharedArrayBuffer(4),
    taskContext: [],
  });
  await result.promise;
  expect(port.postMessage).toHaveBeenCalledWith({
    status: "failed",
    taskId: 1,
    error: "ordinary failure",
  });
  result = createDeferred();
  port.emit("message", {
    taskId: 2,
    nativeSections: new SharedArrayBuffer(4),
    taskContext: [],
  });
  await result.promise;
  expect(port.postMessage).toHaveBeenLastCalledWith(
    { status: "ok", value: "next task", taskId: 2 },
    [],
  );
  expect(handler).toHaveBeenCalledTimes(2);
  expect(port.close).not.toHaveBeenCalled();
  expect(boundary.closeMemory).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(exitCode);
});
