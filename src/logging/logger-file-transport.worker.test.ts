import { afterEach, expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { nativeBoundaryTestEntrypoints } from "../infra/native-boundary-runtime.test-support.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
it("keeps ordinary logger I/O off the main thread while preserving recovery and shutdown", async () => {
  const directory = directories.make("openclaw-file-worker-");
  const result = await runNodeScript(
    (workerArgv) => [
      ...workerArgv(resolveRuntimeWorkerUrl(nativeBoundaryTestEntrypoints.fileLogTransport)),
      directory,
    ],
    { ...process.env, VITEST: "false", NODE_ENV: undefined, TSLOG_SOURCE_MAPS: undefined },
    undefined,
    { requireProcessTreeExit: process.platform !== "win32" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
