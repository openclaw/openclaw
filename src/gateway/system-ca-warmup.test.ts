import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const { createWorker } = vi.hoisted(() => ({
  createWorker: vi.fn<(_source: string) => FakeWorker>(),
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

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  createWorker.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.restoreAllMocks();
});

describe("beginMacOSSystemCaWarmupOnce", () => {
  let beginMacOSSystemCaWarmupOnce: typeof import("./system-ca-warmup.js").beginMacOSSystemCaWarmupOnce;

  beforeEach(async () => {
    vi.resetModules();
    ({ beginMacOSSystemCaWarmupOnce } = await import("./system-ca-warmup.js"));
  });
  it("lets Node resolve the effective default CA set on macOS", async () => {
    const worker = new FakeWorker();
    createWorker.mockReturnValue(worker);
    const warmup = beginMacOSSystemCaWarmupOnce();

    worker.emit("message", { ok: true });
    await warmup;

    expect(createWorker).toHaveBeenCalledOnce();
    const workerSource = createWorker.mock.calls[0]?.[0];
    expect(workerSource).toContain('getCACertificates("default")');
    expect(workerSource).not.toContain('getCACertificates("system")');
    expect(worker.unref).toHaveBeenCalledOnce();
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("bounds a stalled trust lookup and continues startup", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const log = { warn: vi.fn() };
    createWorker.mockReturnValue(worker);
    const warmup = beginMacOSSystemCaWarmupOnce({ log });

    let mainTurnRan = false;
    setImmediate(() => {
      mainTurnRan = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await warmup;

    expect(mainTurnRan).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      "macOS CA warmup timed out after 10000ms; gateway startup will continue and trust settings will load lazily",
    );
    expect(worker.unref).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();

    worker.emit("message", { ok: true });
    worker.emit("exit", 0);
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it("falls back to lazy CA loading when Node denies worker-thread permission", async () => {
    const permissionError = Object.assign(new Error("worker permission denied"), {
      code: "ERR_ACCESS_DENIED",
    });
    const log = { warn: vi.fn() };

    vi.stubEnv("NODE_USE_SYSTEM_CA", "0");
    createWorker.mockImplementation(() => {
      throw permissionError;
    });
    await beginMacOSSystemCaWarmupOnce({ log });

    expect(log.warn).toHaveBeenCalledWith(
      "macOS CA warmup skipped because Node denied worker-thread permission; trust settings will load lazily",
    );
  });

  it("continues startup when the worker cannot populate the cache", async () => {
    const worker = new FakeWorker();
    const log = { warn: vi.fn() };
    createWorker.mockReturnValue(worker);
    const warmup = beginMacOSSystemCaWarmupOnce({ log });

    worker.emit("message", { ok: false, error: "trust store unavailable" });
    await warmup;

    expect(log.warn).toHaveBeenCalledWith(
      "macOS CA warmup failed: trust store unavailable; gateway startup will continue and trust settings will load lazily",
    );
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("continues startup when worker creation fails", async () => {
    const log = { warn: vi.fn() };

    createWorker.mockImplementation(() => {
      throw new Error("worker unavailable");
    });
    await beginMacOSSystemCaWarmupOnce({ log });

    expect(log.warn).toHaveBeenCalledWith(
      "macOS CA warmup skipped because worker creation failed: worker unavailable; trust settings will load lazily",
    );
  });
});

describe("beginMacOSSystemCaWarmupOnce", () => {
  it("shares one worker across concurrent and settled calls", async () => {
    vi.resetModules();
    const { beginMacOSSystemCaWarmupOnce } = await import("./system-ca-warmup.js");
    const worker = new FakeWorker();
    createWorker.mockReturnValue(worker);

    const first = beginMacOSSystemCaWarmupOnce();
    const concurrent = beginMacOSSystemCaWarmupOnce();

    expect(concurrent).toBe(first);
    expect(createWorker).toHaveBeenCalledOnce();

    worker.emit("message", { ok: true });
    await first;

    expect(beginMacOSSystemCaWarmupOnce()).toBe(first);
    expect(createWorker).toHaveBeenCalledOnce();
  });

  it("settles without creating a worker outside macOS", async () => {
    vi.resetModules();
    const { beginMacOSSystemCaWarmupOnce } = await import("./system-ca-warmup.js");
    createWorker.mockImplementation(() => new FakeWorker());
    Object.defineProperty(process, "platform", { value: "linux" });

    await beginMacOSSystemCaWarmupOnce();

    expect(createWorker).not.toHaveBeenCalled();
  });
});
