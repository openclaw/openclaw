import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createChildAdapter } from "./child.js";
import { createStubChild, readyChildAdapter } from "./child.test-support.js";

const startChildAdapter = readyChildAdapter(createChildAdapter);

const { spawnWithFallback, signalProcessTree } = vi.hoisted(() => ({
  spawnWithFallback: vi.fn(),
  signalProcessTree: vi.fn(),
}));
vi.mock("../../spawn-utils.js", () => ({ spawnWithFallback }));
vi.mock("../../kill-tree.js", () => ({ signalProcessTree }));

beforeEach(() => {
  vi.stubEnv("OPENCLAW_SERVICE_MARKER", "");
  spawnWithFallback.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each(["pending", "out-of-order", "out-of-order-disposed"])(
  "reports the existing cleanup deadline while tree signaling is %s",
  async (scenario) => {
    vi.useFakeTimers();
    const stub = createStubChild();
    spawnWithFallback.mockResolvedValue({ child: stub.child, usedFallback: false });
    signalProcessTree.mockImplementationOnce(() => {});
    let failure: unknown;
    const adapter = await startChildAdapter({
      argv: ["synthetic-child"],
      stdinMode: "pipe-open",
      onSpawnCleanup: (cleanup) => {
        cleanup.catch((error: unknown) => {
          failure = error;
        });
      },
    });
    try {
      adapter.kill("SIGKILL");
      if (scenario !== "pending") {
        signalProcessTree.mockImplementationOnce((_pid, _signal, options) => options.onComplete());
        adapter.kill("SIGKILL");
        stub.emitClose(0);
        await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
        if (scenario === "out-of-order-disposed") {
          adapter.dispose();
        }
      }
      await vi.advanceTimersByTimeAsync(4_000);
      expect(failure).toEqual(
        new Error("child cleanup could not be confirmed before the kill deadline"),
      );
    } finally {
      adapter.dispose();
    }
  },
);

it("records tree signaling rejection in cleanup without an unhandled rejection", async () => {
  const stub = createStubChild();
  spawnWithFallback.mockResolvedValue({ child: stub.child, usedFallback: false });
  const failure = new Error("synthetic tree signaling failed");
  signalProcessTree.mockImplementationOnce(() => {
    throw failure;
  });
  let cleanup: Promise<void> | undefined;
  const adapter = await startChildAdapter({
    argv: ["synthetic-child"],
    stdinMode: "pipe-open",
    onSpawnCleanup: (promise) => {
      cleanup = promise;
    },
  });
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    adapter.kill("SIGKILL");
    await nextTurn();
    await nextTurn();
    expect(unhandled).not.toHaveBeenCalled();
    await expect(Promise.allSettled([cleanup])).resolves.toEqual([
      { status: "rejected", reason: failure },
    ]);
  } finally {
    adapter.dispose();
    process.off("unhandledRejection", unhandled);
  }
});

it("reports actual root exit synchronously while output remains open", async () => {
  const stub = createStubChild();
  spawnWithFallback.mockResolvedValue({ child: stub.child, usedFallback: false });
  const adapter = await startChildAdapter({ argv: ["synthetic-child"], stdinMode: "pipe-open" });
  const onExit = vi.fn();
  adapter.onExit(onExit);
  stub.emitExit(1);
  expect(onExit).toHaveBeenCalledExactlyOnceWith(1, null);
  const late = vi.fn();
  adapter.onExit(late);
  expect(late).toHaveBeenCalledExactlyOnceWith(1, null);
  const settled = vi.fn();
  void adapter.wait().then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  stub.emitClose(1);
  await adapter.wait();
  adapter.dispose();
});

it.each(["process", "stdin", "stdout", "stderr"] as const)(
  "retains startup %s errors and forwards live errors",
  async (source) => {
    const stub = createStubChild();
    spawnWithFallback.mockResolvedValue({ child: stub.child, usedFallback: false });
    const adapter = await startChildAdapter({ argv: ["synthetic-child"], stdinMode: "pipe-open" });
    const emitter = source === "process" ? stub.child : stub.child[source]!;
    const early = new Error("startup transport failure");
    emitter.emit("error", early);
    emitter.emit("error", new Error("duplicate startup failure"));
    const onError = vi.fn();
    adapter.onError(onError);
    expect(onError).toHaveBeenCalledExactlyOnceWith(early, source);
    const live = new Error("live transport failure");
    emitter.emit("error", live);
    expect(onError).toHaveBeenLastCalledWith(live, source);
    stub.emitExit(0);
    stub.emitClose(0);
    await adapter.wait();
    adapter.dispose();
  },
);
