import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { serviceChildCleanupRetentionEntrypoint } from "../retention-runtime.test-support.js";

it("releases its caller context while retaining the cleared deadline owner", async ({ signal }) => {
  const result = await runNodeScript(
    (workerArgv) => [
      "--expose-gc",
      ...workerArgv(resolveRuntimeWorkerUrl(serviceChildCleanupRetentionEntrypoint)),
    ],
    { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1" },
    15_000,
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      signal,
      executable: process.execPath,
      maxBuffer: 64 * 1024,
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ callerReleased: true });
}, 30_000);
