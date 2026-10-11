import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";

const runtime = vi.hoisted(() => ({
  assertSupportedRuntime: vi.fn<() => Promise<void>>(),
  runWorkerProcess: vi.fn<() => Promise<void>>(),
  loadWorkerTurnRuntime: vi.fn<() => Promise<void>>(),
  flushCompileCache: vi.fn<() => void>(),
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

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalConnected = process.connected;
const originalDisconnect = Object.getOwnPropertyDescriptor(process, "disconnect");
const disconnect = vi.fn();
let destroyStdin: MockInstance<typeof process.stdin.destroy>;

beforeEach(() => {
  // Each case enters the executable again; the entry deliberately exports no runner.
  vi.resetModules();
  runtime.assertSupportedRuntime.mockReset().mockResolvedValue();
  runtime.runWorkerProcess.mockReset().mockResolvedValue();
  runtime.loadWorkerTurnRuntime.mockReset().mockResolvedValue();
  runtime.flushCompileCache.mockReset();
  process.exitCode = undefined;
  process.connected = true;
  process.disconnect = disconnect.mockReset();
  destroyStdin = vi.spyOn(process.stdin, "destroy").mockReturnValue(process.stdin);
  vi.stubEnv("OPENCLAW_DEBUG", undefined);
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  process.connected = originalConnected;
  if (originalDisconnect) {
    Object.defineProperty(process, "disconnect", originalDisconnect);
  } else {
    Reflect.deleteProperty(process, "disconnect");
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  {
    stage: "runtime validation",
    args: ["--internal-worker-prewarm"],
    message: "Worker runtime startup failed",
  },
  {
    stage: "runtime prewarm",
    args: ["--internal-worker-prewarm"],
    message: "Worker turn runtime load failed",
  },
  {
    stage: "argument validation",
    args: ["--unsupported=fixture-worker-entry-secret"],
    message: "worker deploy entry received unsupported arguments",
  },
  {
    stage: "worker execution",
    args: ["--internal-worker-ipc", "--internal-worker-session"],
    message: "worker live event rejected: invalid-event",
  },
])(
  "reports $stage failure without rejecting the executable entry",
  async ({ stage, args, message }) => {
    process.argv = [process.execPath, "worker.mjs", ...args];
    const secret = "fixture-worker-entry-secret";
    const failure = new Error(`${message} (password=${secret})`, {
      cause: new Error("private execution detail"),
    });
    failure.stack = `${failure.name}: ${failure.message}\n    at worker-bundle-internal-source`;
    if (stage === "runtime validation") {
      runtime.assertSupportedRuntime.mockRejectedValue(failure);
    } else if (stage === "runtime prewarm") {
      runtime.loadWorkerTurnRuntime.mockRejectedValue(failure);
    } else if (stage === "worker execution") {
      runtime.runWorkerProcess.mockRejectedValue(failure);
    }
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(import("./worker-deploy-entry.js")).resolves.toBeDefined();

    expect(process.exitCode).toBe(1);
    expect(destroyStdin).toHaveBeenCalledOnce();
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
  const loading = createDeferred();
  const loaded = createDeferred();
  runtime.loadWorkerTurnRuntime.mockImplementation(() => {
    loading.resolve();
    return loaded.promise;
  });
  process.argv = [process.execPath, "worker.mjs", "--internal-worker-prewarm"];
  const entry = import("./worker-deploy-entry.js");
  await loading.promise;
  expect(runtime.flushCompileCache).not.toHaveBeenCalled();
  loaded.resolve();
  await entry;

  expect(runtime.loadWorkerTurnRuntime).toHaveBeenCalledOnce();
  expect(runtime.flushCompileCache).toHaveBeenCalledOnce();
  expect(runtime.runWorkerProcess).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
  expect(disconnect).toHaveBeenCalledOnce();
});

it("keeps the transport until worker execution has settled", async () => {
  const started = createDeferred();
  const settled = createDeferred();
  runtime.runWorkerProcess.mockImplementation(async () => {
    started.resolve();
    await settled.promise;
  });
  process.argv = [process.execPath, "worker.mjs", "--internal-worker-ipc"];
  const entry = import("./worker-deploy-entry.js");
  await started.promise;
  expect(disconnect).not.toHaveBeenCalled();
  expect(destroyStdin).not.toHaveBeenCalled();
  settled.resolve();
  await entry;
  expect(disconnect).toHaveBeenCalledOnce();
  expect(destroyStdin).toHaveBeenCalledOnce();
});
