import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { nativeWorkerLifecycleEntrypoint } from "./worker-native-lifecycle.runtime.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const exec = promisify(execFile);
const workerUrl = resolveRuntimeWorkerUrl(nativeWorkerLifecycleEntrypoint);
const fixtureArgv = resolveRuntimeWorkerArgv(workerUrl);

type Ending = (typeof endings)[number] | "resource-late-attachment";

async function runFixture(ending: Ending): Promise<unknown> {
  const home = directories.make("worker-native-lifecycle-");
  const { stdout } = await exec(process.execPath, [...fixtureArgv, ending, home], {
    timeout: ending === "resource-late-attachment" ? 45_000 : 15_000,
    killSignal: "SIGKILL",
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, TSX_DISABLE_CACHE: "1" },
  });
  return JSON.parse(stdout);
}

// Each subprocess asserts its real lifecycle boundaries before acknowledging completion.
const endings = [
  "resource-idle-broker",
  "callback-context",
  "native-resource",
  "explicit-unbound",
  "terminate",
  "natural-exit",
  "generation",
] as const;

it.each(endings)(
  "retained native worker lifecycle preserves custody during %s",
  async (ending) => {
    expect(await runFixture(ending)).toEqual({ ending });
  },
  20_000,
);

it("attaches a second resource to the same healthy broker after its cold startup deadline", async () => {
  expect(await runFixture("resource-late-attachment")).toEqual({
    ending: "resource-late-attachment",
  });
}, 50_000);
