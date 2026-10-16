import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { workerTaskPoolEntrypoints } from "./worker-task-pool-runtime.test-support.js";
import type { NativeExchangeScenario } from "./worker-task-pool.native-exchanges.test-support.js";
import type { NativeCancellation } from "./worker-task-pool.native-sections.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

async function runFixture(scenario: NativeExchangeScenario): Promise<unknown> {
  const home = directories.make("worker-native-exchange-");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.nativeExchanges),
      ),
      scenario,
    ],
    {
      timeout: 15_000,
      env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, TSX_DISABLE_CACHE: "1" },
    },
  );
  return JSON.parse(stdout);
}

describe("native worker host exchanges", () => {
  it.each(["close", "before-request"] as const)(
    "unwinds %s into fenced cleanup before retiring the worker",
    async (scenario) => {
      expect(await runFixture(scenario)).toEqual({
        scenario,
        cleanupJoined: true,
        successorStarted: scenario !== "close",
      });
    },
    20_000,
  );

  it.each([
    { scenario: "reply-race", expected: { successorCompleted: true } },
    { scenario: "stale-reply", expected: { unrelatedStaleRejected: true } },
  ] as const)(
    "preserves host exchange ownership during $scenario",
    async ({ scenario, expected }) => {
      expect(await runFixture(scenario)).toEqual({ scenario, ...expected });
    },
  );
});

async function runNativeSectionFixture(ending: NativeCancellation | "exit"): Promise<unknown> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.nativeSections),
      ),
      ending,
    ],
    { timeout: 15_000 },
  );
  return JSON.parse(stdout);
}

describe("worker native-section cancellation", () => {
  it("joins native initialization before settling close and releasing capacity", async () => {
    // Keep the Node 24 zlib destructor regression isolated from the Vitest worker.
    expect(await runNativeSectionFixture("close")).toMatchObject({
      ending: "close",
      cancelled: true,
    });
  }, 20_000);

  it("releases a fenced worker that exits before its native section returns", async () => {
    expect(await runNativeSectionFixture("exit")).toMatchObject({
      ending: "exit",
      exitJoined: true,
    });
  });
});
