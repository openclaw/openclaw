import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { updateRepairWorkerMessageSchema as releasedUpdateRepairWorkerMessageSchema } from "./test-fixtures/update-repair-protocol.v2026-9-4.js";
import type { UpdateRepairWorkerMessage } from "./update-repair-protocol.js";

const runtime = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(async () => {}) }));
// Controllable parent-message parser: pass-through by default; the malformed-input
// case swaps in the real schema to exercise a genuine multi-field parse error.
const schemaParse = vi.hoisted(() => ({ parse: (value: unknown) => value as unknown }));
// mock-isolation: The fake child must not acquire the host CLI scope, plugin resource owners, or process-lifetime job.
vi.mock("../cli/runtime-cleanup-scope.js", () => ({
  withCliProcessScope: (run: () => unknown) => run(),
  retainCliProcessJobUntilExit: async () => {},
}));
vi.mock("../shared/global-singleton.js", async (original) => ({
  ...(await original<typeof import("../shared/global-singleton.js")>()),
  drainGlobalSingletonLifecycleState: runtime.close,
}));
// mock-isolation: The fixture controls turn cancellation; exclude real repair authority, ledger, and agent cleanup state.
vi.mock("./update-repair-turn-worker.js", () => ({ runDelegatedUpdateRepairTurn: runtime.run }));
vi.mock("./update-repair-protocol.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-repair-protocol.js")>()),
  UPDATE_REPAIR_IPC_MAX_BYTES: 65536,
  // Delegate to the controllable parser so the malformed-input case can swap in
  // the real schema at call time (a snapshot would freeze the pass-through).
  updateRepairParentMessageSchema: { parse: (value: unknown) => schemaParse.parse(value) },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  schemaParse.parse = (value: unknown) => value as unknown;
});

type StoppedEvent = Extract<UpdateRepairWorkerMessage, { type: "event" }>["event"] & {
  type: "stopped";
};
const findStopped = (messages: UpdateRepairWorkerMessage[]): StoppedEvent | undefined => {
  for (const message of messages) {
    if (message.type === "event" && message.event.type === "stopped") {
      return message.event as StoppedEvent;
    }
  }
  return undefined;
};

it("joins accepted cancellation cleanup before releasing IPC and native state", async () => {
  vi.resetModules();
  const events = new EventEmitter();
  const entered = createDeferred();
  const returned = createDeferred();
  const tail = createDeferred();
  const disconnected = createDeferred();
  const ready = createDeferred();
  const child = {
    ...process,
    connected: true,
    exitCode: process.exitCode,
    on: events.on.bind(events),
    once: events.once.bind(events),
    off: events.off.bind(events),
    stdin: { destroy: vi.fn() },
    stderr: { write: vi.fn() },
    send: vi.fn((message: { type: string }, callback: (error: Error | null) => void) => {
      if (message.type === "ready") {
        ready.resolve();
      }
      queueMicrotask(() => callback(null));
      return true;
    }),
    disconnect: vi.fn(() => {
      child.connected = false;
      disconnected.resolve();
    }),
    exit: vi.fn(() => {
      throw new Error("unexpected forced exit");
    }),
  };
  child.exitCode = undefined;
  runtime.run.mockImplementation(async (_message, _env, signal: AbortSignal) => {
    entered.resolve();
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    // A bounded agent cleanup can return before its retained tail settles.
    void trackAsyncWork(() => tail.promise);
    returned.resolve();
    return { status: "aborted", reason: "parent gone" };
  });
  vi.stubGlobal("process", child);
  await import("./update-repair.worker.js");
  await ready.promise;
  events.emit("message", { type: "turn" });
  await entered.promise;
  child.connected = false;
  events.emit("disconnect");
  await returned.promise;
  expect(runtime.close).not.toHaveBeenCalled();
  expect(child.stdin.destroy).not.toHaveBeenCalled();
  events.emit("message", { type: "turn" });
  expect(runtime.run).toHaveBeenCalledOnce();
  // Use stdin closure as the terminal receipt because the peer already disconnected.
  child.stdin.destroy.mockImplementation(() => disconnected.resolve());
  tail.resolve();
  await disconnected.promise;
  expect(runtime.close).toHaveBeenCalledOnce();
  expect(child.exitCode).toBe(1);
  expect(child.exit).not.toHaveBeenCalled();
});

it("emits a stopped event and result message when the delegated turn fails", async () => {
  vi.resetModules();
  const events = new EventEmitter();
  const ready = createDeferred();
  const closed = createDeferred();
  const sent: UpdateRepairWorkerMessage[] = [];
  const child = {
    ...process,
    connected: true,
    exitCode: process.exitCode,
    on: events.on.bind(events),
    once: events.once.bind(events),
    off: events.off.bind(events),
    stdin: { destroy: vi.fn(() => closed.resolve()) },
    stderr: { write: vi.fn() },
    send: vi.fn((message: UpdateRepairWorkerMessage, callback: (error: Error | null) => void) => {
      sent.push(message);
      if (message.type === "ready") {
        ready.resolve();
      }
      queueMicrotask(() => callback(null));
      return true;
    }),
    disconnect: vi.fn(() => {
      child.connected = false;
    }),
    exit: vi.fn(() => {
      throw new Error("unexpected forced exit");
    }),
  };
  child.exitCode = undefined;
  runtime.run.mockRejectedValue(new Error("turn exploded"));
  vi.stubGlobal("process", child);
  await import("./update-repair.worker.js");
  await ready.promise;
  events.emit("message", { type: "turn" });
  await closed.promise;
  const stopped = findStopped(sent);
  const result = sent.find((m) => m.type === "result");
  expect(stopped).toMatchObject({
    type: "stopped",
    status: "aborted",
    reason: "turn exploded",
  });
  expect(result?.result).toMatchObject({
    status: "aborted",
    reason: "turn exploded",
  });
  expect(child.exitCode).toBe(1);
  expect(child.exit).not.toHaveBeenCalled();
});

it("bounds parse-error reasons and emits responses the released parser accepts", async () => {
  const realProtocol = await vi.importActual<typeof import("./update-repair-protocol.js")>(
    "./update-repair-protocol.js",
  );
  schemaParse.parse = (value: unknown) => realProtocol.updateRepairParentMessageSchema.parse(value);
  // Multi-field malformed "turn" (every required field wrong) produces a Zod error
  // whose message exceeds the protocol's 1024-char text cap.
  const malformed = {
    type: "turn",
    runId: 123,
    target: "nope",
    executor: 5,
    prompt: { o: 1 },
    wallClockMs: "x",
    timeoutMs: "y",
    maxToolCalls: "z",
  };
  let rawLength = 0;
  try {
    realProtocol.updateRepairParentMessageSchema.parse(malformed);
  } catch (error) {
    rawLength = (error as Error).message.length;
  }
  expect(rawLength).toBeGreaterThan(1024);

  vi.resetModules();
  const events = new EventEmitter();
  const ready = createDeferred();
  const closed = createDeferred();
  const sent: UpdateRepairWorkerMessage[] = [];
  const child = {
    ...process,
    connected: true,
    exitCode: process.exitCode,
    on: events.on.bind(events),
    once: events.once.bind(events),
    off: events.off.bind(events),
    stdin: { destroy: vi.fn(() => closed.resolve()) },
    stderr: { write: vi.fn() },
    send: vi.fn((message: UpdateRepairWorkerMessage, callback: (error: Error | null) => void) => {
      sent.push(message);
      if (message.type === "ready") {
        ready.resolve();
      }
      queueMicrotask(() => callback(null));
      return true;
    }),
    disconnect: vi.fn(() => {
      child.connected = false;
    }),
    exit: vi.fn(() => {
      throw new Error("unexpected forced exit");
    }),
  };
  child.exitCode = undefined;
  vi.stubGlobal("process", child);
  await import("./update-repair.worker.js");
  await ready.promise;
  events.emit("message", malformed);
  await closed.promise;
  const stopped = findStopped(sent);
  const result = sent.find((m) => m.type === "result");
  expect(stopped?.status).toBe("aborted");
  expect(result?.result.status).toBe("aborted");
  expect(result?.result.reason?.length ?? 0).toBeLessThanOrEqual(1024);
  expect(result?.result.finalValidation.summary.length).toBeLessThanOrEqual(1024);
  // The frozen v2026.9.4 released parser must accept every emitted message.
  for (const message of sent) {
    expect(releasedUpdateRepairWorkerMessageSchema.safeParse(message).success).toBe(true);
  }
  expect(child.exitCode).toBe(1);
});
