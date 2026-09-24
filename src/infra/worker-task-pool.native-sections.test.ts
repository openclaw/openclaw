import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { workerTaskPoolEntrypoints } from "./worker-task-pool-runtime.test-support.js";
import type { NativeCancellation } from "./worker-task-pool.native-sections.test-support.js";

async function runFixture(ending: NativeCancellation | "exit"): Promise<unknown> {
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
  it.each<NativeCancellation>(["abort", "timeout", "close"])(
    "joins native initialization before settling %s and releasing capacity",
    async (ending) => {
      // Keep the Node 24 zlib destructor regression isolated from the Vitest worker.
      expect(await runFixture(ending)).toMatchObject({ ending, cancelled: true });
    },
    20_000,
  );

  it("releases a fenced worker that exits before its native section returns", async () => {
    expect(await runFixture("exit")).toMatchObject({ ending: "exit", exitJoined: true });
  });
});
