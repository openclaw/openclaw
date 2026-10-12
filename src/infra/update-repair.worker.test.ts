import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";

const runtime = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(async () => {}) }));
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
  updateRepairParentMessageSchema: { parse: (value: unknown) => value },
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

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
