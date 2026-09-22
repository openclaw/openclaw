import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { NativeExchangeScenario } from "./worker-task-pool.native-exchanges.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

async function runFixture(scenario: NativeExchangeScenario): Promise<unknown> {
  const home = directories.make("worker-native-exchange-");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
      fileURLToPath(
        new URL("./worker-task-pool.native-exchanges.test-support.ts", import.meta.url),
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
  it.each(["abort", "close", "before-request"] as const)(
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

  it.each(["late-reply", "reply-race"] as const)(
    "discards only the canceled exchange during %s",
    async (scenario) => {
      expect(await runFixture(scenario)).toEqual({ scenario, successorCompleted: true });
    },
  );

  it("still rejects an unrelated stale reply", async () => {
    expect(await runFixture("stale-reply")).toEqual({
      scenario: "stale-reply",
      unrelatedStaleRejected: true,
    });
  });

  it("joins cancellation observers before reusing a healthy worker", async () => {
    expect(await runFixture("reuse")).toEqual({ scenario: "reuse", waiterFreeTasks: 16 });
  });
});
