import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { updateRepairWorkerMessageSchema as releasedUpdateRepairWorkerMessageSchema } from "./test-fixtures/update-repair-protocol.v2026-9-4.js";
import type { UpdateRepairWorkerMessage } from "./update-repair-protocol.js";

const runtime = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(async () => {}) }));
// Malformed-input coverage switches from the controlled turn fixture to the real parser.
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
  updateRepairParentMessageSchema: { parse: (value: unknown) => schemaParse.parse(value) },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  schemaParse.parse = (value: unknown) => value as unknown;
});

function expectFailure(sent: UpdateRepairWorkerMessage[]) {
  const stopped = sent.find((m) => m.type === "event" && m.event.type === "stopped");
  const result = sent.find((m) => m.type === "result")?.result;
  expect(stopped).toMatchObject({
    event: { type: "stopped", status: "aborted", reason: result?.reason },
  });
  expect(result?.status).toBe("aborted");
  return result;
}

async function startChild() {
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
  return { child, events, closed, sent };
}

it("joins accepted cancellation cleanup before releasing IPC and native state", async () => {
  const entered = createDeferred();
  const returned = createDeferred();
  const tail = createDeferred();
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
  const { child, events, closed } = await startChild();
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
  tail.resolve();
  await closed.promise;
  expect(runtime.close).toHaveBeenCalledOnce();
  expect(child.exitCode).toBe(1);
  expect(child.exit).not.toHaveBeenCalled();
});

it("emits a stopped event and result message when the delegated turn fails", async () => {
  runtime.run.mockRejectedValue(new Error("turn exploded"));
  const { child, events, closed, sent } = await startChild();
  events.emit("message", { type: "turn" });
  await closed.promise;
  expect(expectFailure(sent)).toMatchObject({ reason: "turn exploded" });
  expect(child.exitCode).toBe(1);
  expect(child.exit).not.toHaveBeenCalled();
});

it("bounds parse-error reasons and emits responses the released parser accepts", async () => {
  const realProtocol = await vi.importActual<typeof import("./update-repair-protocol.js")>(
    "./update-repair-protocol.js",
  );
  schemaParse.parse = (value: unknown) => realProtocol.updateRepairParentMessageSchema.parse(value);
  // A multi-field Zod error exceeds the released protocol's text cap.
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
  const parsed = realProtocol.updateRepairParentMessageSchema.safeParse(malformed);
  expect(parsed.error?.message.length).toBeGreaterThan(1024);

  const { child, events, closed, sent } = await startChild();
  events.emit("message", malformed);
  await closed.promise;
  const result = expectFailure(sent);
  expect(result?.reason?.length ?? 0).toBeLessThanOrEqual(1024);
  expect(result?.finalValidation.summary.length).toBeLessThanOrEqual(1024);
  // The frozen v2026.9.4 released parser must accept every emitted message.
  for (const message of sent) {
    expect(releasedUpdateRepairWorkerMessageSchema.safeParse(message).success).toBe(true);
  }
  expect(child.exitCode).toBe(1);
});
