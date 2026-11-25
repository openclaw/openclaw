import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runRetentionNodeScript } from "../../test/helpers/run-node-script.js";
import { execOutputRetentionEntrypoint } from "./retention-runtime.test-support.js";

it("releases discarded backing buffers while capped commands are still running", async ({
  signal,
}) => {
  const result = await runRetentionNodeScript(execOutputRetentionEntrypoint, {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    signal,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    { mode: "head", retained: false, poolRetained: false },
    { mode: "combined-head", retained: false, poolRetained: false },
    { mode: "tail", retained: false, poolRetained: false },
    { mode: "combined-tail", retained: false, poolRetained: false },
  ]);
}, 30_000);
