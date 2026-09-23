import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { execOutputRetentionEntrypoint } from "./retention-runtime.test-support.js";

it("releases discarded backing buffers while capped commands are still running", async ({
  signal,
}) => {
  const result = await runNodeScript(
    [
      "--expose-gc",
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(execOutputRetentionEntrypoint),
        resolveTestNodeExecPath(),
      ),
    ],
    { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1" },
    15_000,
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      signal,
      maxBuffer: 64 * 1024,
      requireProcessTreeExit: process.platform !== "win32",
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    { mode: "head", retained: false },
    { mode: "combined-head", retained: false },
    { mode: "tail", retained: false },
  ]);
}, 30_000);
