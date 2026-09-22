import { afterEach, expect, it } from "vitest";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mjs";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("loads installed tooling when the prepared CLI validates native Vitest options", async ({
  signal,
}) => {
  const directory = tempDirs.make("openclaw-compiled-tooling-");
  const result = await runNodeScript(
    [
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(scriptModuleEntrypoints.testProjects),
        resolveTestNodeExecPath(),
      ),
      "test/scripts/test-projects.test.ts",
      "--",
      "--invalid-native-vitest-option",
    ],
    { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
    5_000,
    { signal, requireProcessTreeExit: process.platform !== "win32" },
  );

  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Unknown option");
  expect(result.stderr).toContain("invalid");
  expect(result.stderr).not.toContain("[test] starting");
});
