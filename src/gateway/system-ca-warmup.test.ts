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
  let worker: FakeWorker;
  let log: { warn: ReturnType<typeof vi.fn<(message: string) => void>> };

  beforeEach(async () => {
    vi.resetModules();
    ({ beginMacOSSystemCaWarmupOnce } = await import("./system-ca-warmup.js"));
    worker = new FakeWorker();
    log = { warn: vi.fn<(message: string) => void>() };
    createWorker.mockReturnValue(worker);
  });
  it("shares Node's default CA warmup across concurrent and settled macOS calls", async () => {
    const warmup = beginMacOSSystemCaWarmupOnce();
    expect(beginMacOSSystemCaWarmupOnce()).toBe(warmup);

    worker.emit("message", { ok: true });
    await warmup;

    expect(createWorker).toHaveBeenCalledOnce();
    const workerSource = createWorker.mock.calls[0]?.[0];
    expect(workerSource).toContain('getCACertificates("default")');
    expect(workerSource).not.toContain('getCACertificates("system")');
    expect(worker.unref).toHaveBeenCalledOnce();
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(beginMacOSSystemCaWarmupOnce()).toBe(warmup);
    expect(createWorker).toHaveBeenCalledOnce();
  });

  it("bounds a stalled trust lookup and continues startup", async () => {
    vi.useFakeTimers();
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

  it.each([
    ["ERR_ACCESS_DENIED", "worker permission denied", "Node denied worker-thread permission"],
    [undefined, "worker unavailable", "worker creation failed: worker unavailable"],
  ])(
    "falls back to lazy loading after worker creation fails (%s)",
    async (code, message, reason) => {
      vi.stubEnv("NODE_USE_SYSTEM_CA", "0");
      createWorker.mockImplementation(() => {
        throw Object.assign(new Error(message), { code });
      });
      await beginMacOSSystemCaWarmupOnce({ log });
      expect(log.warn).toHaveBeenCalledWith(
        `macOS CA warmup skipped because ${reason}; trust settings will load lazily`,
      );
    },
  );

  it("continues startup when the worker cannot populate the cache", async () => {
    const warmup = beginMacOSSystemCaWarmupOnce({ log });

    worker.emit("message", { ok: false, error: "trust store unavailable" });
    await warmup;

    expect(log.warn).toHaveBeenCalledWith(
      "macOS CA warmup failed: trust store unavailable; gateway startup will continue and trust settings will load lazily",
    );
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("settles without creating a worker outside macOS", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });

    await beginMacOSSystemCaWarmupOnce();

    expect(createWorker).not.toHaveBeenCalled();
  });
});
