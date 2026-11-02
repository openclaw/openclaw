import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { SpawnResult } from "../process/exec-result.js";
import {
  resolveCommandProcessSignal as processSignal,
  withCommandProcessScope,
} from "../process/exec-spawn.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { executeSystemAgentOperation as execute } from "./operations-execute.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";

vi.mock("../process/exec.js", () => ({ runUtf8CommandWithTimeout: vi.fn() }));

afterEach(() => vi.resetAllMocks());

function completed(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return createCommandResult({ cleanup: "normal", ...overrides });
}

it.each(["cancellation", "output failure"])(
  "joins admitted Doctor work after %s before releasing the caller",
  async (cause) => {
    const started = createDeferredCore();
    const finished = createDeferredCore<SpawnResult>();
    const terminate = vi.fn(() =>
      finished.resolve(completed({ code: null, termination: "signal" })),
    );
    vi.mocked(runUtf8CommandWithTimeout).mockImplementation((_argv, options) => {
      assert(typeof options !== "number");
      processSignal(options.signal)?.addEventListener("abort", terminate, { once: true });
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
      operation = execute({ kind: "doctor" }, runtime);
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
      expect([terminate.mock.calls.length, settled]).toEqual([0, false]);
    } finally {
      finished.resolve(completed());
    }
    await scope;
    await expect(operation).rejects.toThrow(
      cause === "cancellation" ? "aborted" : outputError.message,
    );
  },
);

it("bounds Doctor output and preserves split UTF-8", async () => {
  vi.mocked(runUtf8CommandWithTimeout).mockImplementation(async (_argv, options) => {
    assert(typeof options !== "number");
    const emoji = Buffer.from("🦞\n");
    options.onOutputChunk?.(emoji.subarray(0, 2), "stdout");
    options.onOutputChunk?.(emoji.subarray(2), "stdout");
    options.onOutputChunk?.(Buffer.alloc(2 * 1024 * 1024, "x"), "stderr");
    return completed();
  });
  const { runtime, lines } = createSystemAgentTestRuntime();
  await expect(execute({ kind: "doctor" }, runtime)).resolves.toEqual({ applied: false });
  expect(lines[0]).toBe("🦞");
  expect(Buffer.byteLength(lines.join("\n"))).toBeLessThan(1024 * 1024 + 512);
  expect(lines.at(-1)).toMatch(/Doctor output was truncated.*`openclaw doctor --lint`/);
});
