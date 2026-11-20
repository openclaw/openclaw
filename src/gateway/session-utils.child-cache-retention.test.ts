import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runRetentionNodeScript } from "../../test/helpers/run-node-script.js";
import { sessionChildCacheRetentionEntrypoint } from "./session-child-cache-retention-entrypoint.test-support.js";

it("keeps child links without retaining released session metadata", async ({ signal }) => {
  const result = await runRetentionNodeScript(sessionChildCacheRetentionEntrypoint, {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    signal,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ retained: [] });
}, 30_000);
