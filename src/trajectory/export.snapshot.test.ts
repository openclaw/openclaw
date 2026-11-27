import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { snapshotExportTestEntrypoint } from "./export.snapshot-runtime.test-support.js";

it("exports a complete large snapshot through the recorder and bounded SQLite rows", async () => {
  const result = await runNodeScript(
    (workerArgv) => workerArgv(resolveRuntimeWorkerUrl(snapshotExportTestEntrypoint)),
    process.env,
    undefined,
    { maxBuffer: 1024 * 1024, requireProcessTreeExit: process.platform !== "win32" },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});
