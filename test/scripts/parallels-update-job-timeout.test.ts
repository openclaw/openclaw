import { spawnSync } from "node:child_process";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runTimedUpdateJob } from "../../scripts/e2e/parallels/update-job-timeout.ts";
import { scriptProcessEntrypoints } from "../../scripts/script-process-runtime.test-support.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";

let events: string[];
beforeEach(() => {
  events = [];
});
const runJob = (options: Partial<Parameters<typeof runTimedUpdateJob>[0]>) =>
  runTimedUpdateJob({
    append: (chunk) => events.push(chunk),
    label: "macOS",
    run: async () => undefined,
    timeoutDescription: "1s plus cleanup backstop",
    timeoutMs: 1000,
    ...options,
  });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("clamps oversized update job timers before scheduling", async () => {
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
  await expect(runJob({ timeoutMs: Number.MAX_SAFE_INTEGER })).resolves.toBe(0);
  expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
});
it("records update failures", async () => {
  await expect(
    runJob({
      run: async () => {
        throw new Error("package swap failed");
      },
    }),
  ).resolves.toBe(1);
  expect(events).toEqual(["package swap failed\n"]);
});
it("lets the inner bounded operation settle before the backstop fires", async () => {
  vi.useFakeTimers();
  const result = runJob({
    run: () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 1000);
      }),
    timeoutMs: 1200,
  });
  await vi.advanceTimersByTimeAsync(1000);
  await expect(result).resolves.toBe(0);
  expect(events).toEqual([]);
});
it("waits for abort-aware cleanup before completing the job", async () => {
  vi.useFakeTimers();
  const result = runJob({
    abortSettleMs: 250,
    append: (chunk) => events.push(chunk.trim()),
    run: ({ signal }) =>
      new Promise<void>((resolve) => {
        const onAbort = () => {
          events.push("abort");
          setTimeout(() => {
            events.push("cleanup");
            resolve();
          }, 25);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }),
  }).then((code) => {
    events.push("complete");
    return code;
  });
  await vi.advanceTimersByTimeAsync(1025);
  await expect(result).resolves.toBe(1);
  const timeoutMessage = "macOS update timed out after 1s plus cleanup backstop";
  expect(events).toEqual([timeoutMessage, "abort", "cleanup", "complete"]);
});
it("keeps the process alive long enough to write logs for hung runners", () => {
  const moduleUrl = resolveRuntimeWorkerUrl(scriptProcessEntrypoints.updateJobTimeout);
  const probe = `
import { runTimedUpdateJob } from ${JSON.stringify(moduleUrl.href)};
const events = [];
const result = await runTimedUpdateJob({
  abortSettleMs: 25,
  append: (chunk) => events.push(chunk.trim()),
  label: "Linux",
  run: () => new Promise(() => {}),
  timeoutDescription: "10ms",
  timeoutMs: 10,
});
console.log(JSON.stringify({ events, result }));
`;

  const child = spawnSync(
    process.execPath,
    [...resolveRuntimeWorkerArgv(moduleUrl).slice(0, -1), "--input-type=module", "--eval", probe],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );

  expect(child).toMatchObject({ stderr: "", status: 0 });
  expect(JSON.parse(child.stdout)).toEqual({
    events: ["Linux update timed out after 10ms"],
    result: 1,
  });
});
