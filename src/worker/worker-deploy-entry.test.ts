import { afterEach, beforeEach, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  assertSupportedRuntime: vi.fn<() => Promise<void>>(),
  runWorkerProcess: vi.fn<() => Promise<void>>(),
}));

vi.mock("./worker-deploy-runtime.js", () => ({}));
vi.mock("../process/output-drain.js", () => ({ drainProcessOutput: vi.fn() }));
vi.mock("../infra/runtime-guard.js", () => ({
  assertSupportedRuntime: runtime.assertSupportedRuntime,
}));
vi.mock("./worker-process.js", () => ({ runWorkerProcess: runtime.runWorkerProcess }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

beforeEach(() => {
  // Each case enters the executable again; the entry deliberately exports no runner.
  vi.resetModules();
  runtime.assertSupportedRuntime.mockReset().mockResolvedValue();
  runtime.runWorkerProcess.mockReset().mockResolvedValue();
  process.exitCode = undefined;
  vi.stubEnv("OPENCLAW_DEBUG", undefined);
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
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
    } else if (stage === "worker execution") {
      runtime.runWorkerProcess.mockRejectedValue(failure);
    }
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(import("./worker-deploy-entry.js")).resolves.toBeDefined();

    expect(process.exitCode).toBe(1);
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
