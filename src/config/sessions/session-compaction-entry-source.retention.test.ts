import { expect, it } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";

it("detaches cached bounded facts from full tool payload strings", async ({ signal }) => {
  const entrypoint = resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "session-compaction-entry-source.retention.test-support",
    distWorkerPath: "config/sessions/session-compaction-entry-source.retention.test-support.js",
  });
  const result = await runNodeScript(
    (workerArgv) => ["--expose-gc", ...workerArgv(entrypoint)],
    { ...process.env, NODE_OPTIONS: "" },
    undefined,
    { signal, requireProcessTreeExit: process.platform !== "win32", maxBuffer: 64 * 1024 },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('"facts":32');
});
