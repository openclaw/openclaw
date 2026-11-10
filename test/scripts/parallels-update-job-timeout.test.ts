import { spawnSync } from "node:child_process";
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
afterEach(() => vi.useRealTimers());
it.each([false, true])("settles before the backstop (fails=%s)", async (fails) => {
  vi.useFakeTimers();
  const result = runJob({
    run: () =>
      fails
        ? Promise.reject(new Error("package swap failed"))
        : new Promise<void>((resolve) => {
            setTimeout(resolve, 1000);
          }),
    timeoutMs: 1200,
  });
  await vi.advanceTimersByTimeAsync(1000);
  await expect(result).resolves.toBe(fails ? 1 : 0);
  expect(events).toEqual(fails ? ["package swap failed\n"] : []);
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
const result = await runTimedUpdateJob({
  abortSettleMs: 25,
  append: (chunk) => process.stdout.write(chunk),
  label: "Linux",
  run: () => new Promise(() => {}),
  timeoutDescription: "10ms",
  timeoutMs: 10,
});
console.log(result);
`;

  const child = spawnSync(
    process.execPath,
    [...resolveRuntimeWorkerArgv(moduleUrl).slice(0, -1), "--input-type=module", "--eval", probe],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );

  expect(child).toMatchObject({
    stderr: "",
    status: 0,
    stdout: "Linux update timed out after 10ms\n1\n",
  });
});
