import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  POST_CORE_EXECUTOR_CAPABILITY,
  POST_CORE_MUTATION_PROTOCOL,
} from "./update-post-core-capability.js";

it("advertises the post-core executor through the actual compiled worker check", async () => {
  await withTestDir({ prefix: "post-core-capability-" }, async (root) => {
    const url = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateMigratedFinalize);
    expect(url.pathname).toMatch(/\.js$/);
    const check = spawnSync(process.execPath, [...resolveRuntimeWorkerArgv(url), "--check"], {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
    expect(check.error).toBeUndefined();
    expect(check.signal).toBeNull();
    expect(check.status, check.stderr).toBe(0);
    expect(JSON.parse(check.stdout)).toMatchObject({
      executorDelegation: "pid-start-v1",
      postCoreExecutor: POST_CORE_EXECUTOR_CAPABILITY,
      mutationProtocol: POST_CORE_MUTATION_PROTOCOL,
    });
  });
});
