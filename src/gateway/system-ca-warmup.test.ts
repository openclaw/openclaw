import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const { createWorker } = vi.hoisted(() => ({
  createWorker: vi.fn<(_source: string | URL) => FakeWorker>(),
}));

vi.mock("../infra/worker-cpu.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-cpu.js")>()),
  createCpuTrackedWorker: createWorker,
}));
vi.mock("../infra/env.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/env.js")>()),
  isVitestRuntimeEnv: () => false,
}));

class FakeWorker extends EventEmitter {
  terminate = vi.fn(async () => 0);
  unref = vi.fn();
}

let begin: typeof import("./system-ca-warmup.js").beginMacOSSystemCaWarmupOnce;
let worker: FakeWorker;
const log = { warn: vi.fn<(message: string) => void>() };
beforeEach(async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  createWorker.mockReset();
  log.warn.mockReset();
  vi.resetModules();
  ({ beginMacOSSystemCaWarmupOnce: begin } = await import("./system-ca-warmup.js"));
  worker = new FakeWorker();
  createWorker.mockReturnValue(worker);
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.restoreAllMocks();
});

it("shares Node's default CA warmup across concurrent and settled macOS calls", async () => {
  const warmup = begin();
  expect(begin()).toBe(warmup);

  worker.emit("message", { ok: true });
  await warmup;

  expect(worker.unref).toHaveBeenCalledOnce();
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(begin()).toBe(warmup);
  expect(createWorker).toHaveBeenCalledOnce();
});

it.each([
  ["timeout", undefined, "timed out after 10000ms"],
  ["message", undefined, "trust store unavailable"],
  ["creation", "ERR_ACCESS_DENIED", "Node denied worker-thread permission"],
  ["creation", undefined, "worker creation failed: worker unavailable"],
] as const)("continues startup after %s failure (%s)", async (failure, code, reason) => {
  vi.useFakeTimers();
  if (failure === "creation") {
    createWorker.mockImplementation(() => {
      throw Object.assign(new Error("worker unavailable"), { code });
    });
  }
  const warmup = begin({ log });
  if (failure === "timeout") {
    const mainTurn = vi.fn();
    setImmediate(mainTurn);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mainTurn).toHaveBeenCalledOnce();
    expect(worker.unref).toHaveBeenCalledOnce();
  } else if (failure === "message") {
    worker.emit("message", { ok: false, error: reason });
  }
  await warmup;
  expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(reason));
  expect(worker.terminate).toHaveBeenCalledTimes(failure === "creation" ? 0 : 1);
  worker.emit("message", { ok: true });
  worker.emit("exit", 0);
  expect(log.warn).toHaveBeenCalledOnce();
});

it("settles without creating a worker outside macOS", async () => {
  Object.defineProperty(process, "platform", { value: "linux" });

  await begin();

  expect(createWorker).not.toHaveBeenCalled();
});
