import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { SpawnResult } from "../process/exec-result.js";
import { resolveCommandProcessSignal, withCommandProcessScope } from "../process/exec-spawn.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import { executeSystemAgentOperation } from "./operations-execute.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

vi.mock("../process/exec.js", () => ({ runUtf8CommandWithTimeout: vi.fn() }));

afterEach(() => vi.resetAllMocks());

function completed(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    code: 0,
    stdout: "",
    stderr: "",
    signal: null,
    termination: "exit",
    killed: false,
    cleanup: "normal",
    ...overrides,
  };
}

it.each([
  { result: completed({ code: 7 }), error: "exit 7" },
  {
    result: completed({ code: null, signal: "SIGTERM", termination: "signal" }),
    error: "Doctor process stopped unexpectedly (signal)",
  },
  {
    result: completed({ cleanup: "uncertain" }),
    error: "Command cleanup could not confirm that owned work stopped",
  },
])("preserves Doctor process failure: $error", async ({ result, error }) => {
  vi.mocked(runUtf8CommandWithTimeout).mockImplementation(async (_argv, options) => {
    assert(typeof options !== "number");
    options.onOutputChunk?.(Buffer.from("Doctor diagnostic\n"), "stderr");
    return result;
  });
  const { runtime, lines } = createSystemAgentTestRuntime();
  await expect(executeSystemAgentOperation({ kind: "doctor" }, runtime)).rejects.toThrow(error);
  expect(lines).toContain("Doctor diagnostic");
});

it.each(["cancellation", "output failure"])(
  "joins admitted Doctor work after %s before releasing the caller",
  async (cause) => {
    const started = createDeferredCore();
    const finished = createDeferredCore<SpawnResult>();
    let terminated = false;
    vi.mocked(runUtf8CommandWithTimeout).mockImplementation((_argv, options) => {
      assert(typeof options !== "number");
      resolveCommandProcessSignal(options.signal)?.addEventListener(
        "abort",
        () => {
          terminated = true;
          finished.resolve(completed({ code: null, termination: "signal" }));
        },
        { once: true },
      );
      options.onOutputChunk?.(Buffer.from("Doctor running\n"), "stdout");
      started.resolve();
      return finished.promise;
    });
    const { runtime } = createSystemAgentTestRuntime();
    const outputError = new Error("Output consumer closed");
    if (cause === "output failure") {
      runtime.log = () => {
        throw outputError;
      };
    }
    let operation: Promise<unknown> | undefined;
    let settled = false;
    const scope = withCommandProcessScope(async (stop) => {
      operation = executeSystemAgentOperation({ kind: "doctor" }, runtime);
      void operation.catch(() => {});
      await started.promise;
      if (cause === "cancellation") {
        stop();
      }
    }).finally(() => {
      settled = true;
    });
    try {
      await started.promise;
      await nextTurn();
      expect(terminated).toBe(false);
      expect(settled).toBe(false);
    } finally {
      finished.resolve(completed());
    }
    await scope;
    await expect(operation).rejects.toThrow(
      cause === "cancellation" ? "aborted" : outputError.message,
    );
  },
);

it("bounds Doctor output without stopping accepted work and preserves split UTF-8", async () => {
  let completedWork = false;
  vi.mocked(runUtf8CommandWithTimeout).mockImplementation(async (_argv, options) => {
    assert(typeof options !== "number");
    const emoji = Buffer.from("🦞\n");
    options.onOutputChunk?.(emoji.subarray(0, 2), "stdout");
    options.onOutputChunk?.(emoji.subarray(2), "stdout");
    options.onOutputChunk?.(Buffer.alloc(2 * 1024 * 1024, "x"), "stderr");
    completedWork = true;
    return completed();
  });
  const { runtime, lines } = createSystemAgentTestRuntime();
  await expect(executeSystemAgentOperation({ kind: "doctor" }, runtime)).resolves.toEqual({
    applied: false,
  });
  expect(completedWork).toBe(true);
  expect(lines[0]).toBe("🦞");
  expect(Buffer.byteLength(lines.join("\n"))).toBeLessThan(1024 * 1024 + 512);
  expect(lines.at(-1)).toContain("Doctor output was truncated");
});
