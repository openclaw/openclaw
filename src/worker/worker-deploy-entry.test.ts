import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const runtime = vi.hoisted(() => ({
  assertSupportedRuntime: vi.fn<() => Promise<void>>(),
  runWorkerProcess: vi.fn<() => Promise<void>>(),
  loadWorkerTurnRuntime: vi.fn<() => Promise<void>>(),
  flushCompileCache: vi.fn<() => void>(),
  releaseProcessStdin: vi.fn<() => void>(),
}));

vi.mock("node:module", async (importOriginal) => ({
  createRequire: (await importOriginal<typeof import("node:module")>()).createRequire,
  flushCompileCache: runtime.flushCompileCache,
}));
vi.mock("./worker-deploy-runtime.js", () => ({}));
vi.mock("./worker.runtime.js", () => ({ loadWorkerTurnRuntime: runtime.loadWorkerTurnRuntime }));
vi.mock("../infra/runtime-guard.js", () => ({
  assertSupportedRuntime: runtime.assertSupportedRuntime,
}));
vi.mock("./worker-process.js", () => ({ runWorkerProcess: runtime.runWorkerProcess }));
// mock-isolation: the real helper would inspect and destroy the test runner's own stdin.
vi.mock("../process/release-stdin.js", () => ({
  releaseProcessStdin: runtime.releaseProcessStdin,
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalTransport = ["connected", "disconnect"].map(
  (key) => [key, Object.getOwnPropertyDescriptor(process, key)] as const,
);
const disconnect = vi.fn();

beforeEach(() => {
  // Each case enters the executable again; the entry deliberately exports no runner.
  vi.resetModules();
  runtime.assertSupportedRuntime.mockReset().mockResolvedValue();
  runtime.runWorkerProcess.mockReset().mockResolvedValue();
  runtime.loadWorkerTurnRuntime.mockReset().mockResolvedValue();
  runtime.flushCompileCache.mockReset();
  process.exitCode = undefined;
  Object.defineProperty(process, "connected", { configurable: true, value: true, writable: true });
  process.disconnect = disconnect.mockReset();
  runtime.releaseProcessStdin.mockReset();
  vi.stubEnv("OPENCLAW_DEBUG", undefined);
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  for (const [key, descriptor] of originalTransport) {
    if (descriptor) {
      Object.defineProperty(process, key, descriptor);
    } else {
      Reflect.deleteProperty(process, key);
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function holdEntry(mock: typeof runtime.runWorkerProcess, arg: string) {
  const entered = createDeferred();
  const release = createDeferred();
  mock.mockImplementation(() => {
    entered.resolve();
    return release.promise;
  });
  process.argv = [process.execPath, "worker.mjs", arg];
  return { entered: entered.promise, release, entry: import("./worker-deploy-entry.js") };
}

const prewarm = ["--internal-worker-prewarm"] as const;
it.each([
  ["runtime validation", prewarm, "Worker runtime startup failed", runtime.assertSupportedRuntime],
  ["runtime prewarm", prewarm, "Worker turn runtime load failed", runtime.loadWorkerTurnRuntime],
  [
    "argument validation",
    ["--unsupported=fixture-worker-entry-secret"],
    "worker deploy entry received unsupported arguments",
    undefined,
  ],
  [
    "worker execution",
    ["--internal-worker-ipc", "--internal-worker-session"],
    "worker live event rejected: invalid-event",
    runtime.runWorkerProcess,
  ],
] as const)(
  "reports %s failure without rejecting the executable entry",
  async (stage, args, message, fail) => {
    process.argv = [process.execPath, "worker.mjs", ...args];
    const secret = "fixture-worker-entry-secret";
    const failure = new Error(`${message} (password=${secret})`, {
      cause: new Error("private execution detail"),
    });
    failure.stack = `${failure.name}: ${failure.message}\n    at worker-bundle-internal-source`;
    fail?.mockRejectedValue(failure);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(import("./worker-deploy-entry.js")).resolves.toBeDefined();

    expect(process.exitCode).toBe(1);
    expect(runtime.releaseProcessStdin).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(runtime.flushCompileCache).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledOnce();
    const diagnostic = String(stderr.mock.calls[0]?.[0]);
    expect(diagnostic).toContain(message);
    expect(diagnostic.endsWith("\n")).toBe(true);
    expect(diagnostic).not.toContain(secret);
    expect(diagnostic).not.toContain("worker-bundle-internal-source");
    expect(diagnostic).not.toContain("private execution detail");
    if (stage !== "worker execution") {
      expect(runtime.runWorkerProcess).not.toHaveBeenCalled();
    }
  },
);

it("prewarms the turn runtime before flushing its compile cache", async () => {
  const { entered, release, entry } = holdEntry(runtime.loadWorkerTurnRuntime, prewarm[0]);
  await entered;
  expect(runtime.flushCompileCache).not.toHaveBeenCalled();
  release.resolve();
  await entry;

  expect(runtime.loadWorkerTurnRuntime).toHaveBeenCalledOnce();
  expect(runtime.flushCompileCache).toHaveBeenCalledOnce();
  expect(runtime.runWorkerProcess).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
  expect(disconnect).toHaveBeenCalledOnce();
});

it("keeps the transport until worker execution has settled", async () => {
  const { entered, release, entry } = holdEntry(runtime.runWorkerProcess, "--internal-worker-ipc");
  await entered;
  expect(disconnect).not.toHaveBeenCalled();
  expect(runtime.releaseProcessStdin).not.toHaveBeenCalled();
  release.resolve();
  await entry;
  expect(disconnect).toHaveBeenCalledOnce();
  expect(runtime.releaseProcessStdin).toHaveBeenCalledOnce();
});
