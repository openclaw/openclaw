import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { localStateOwnerFixtureEntrypoint } from "../cli/cli-entrypoint.test-support.js";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const entrypoint = resolveRuntimeWorkerArgv(
  resolveRuntimeWorkerUrl(localStateOwnerFixtureEntrypoint),
);

function environment(root: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
}

it("retains and seals migration ownership after uncertain child cleanup until process exit", async () => {
  const root = roots.make("openclaw-migration-uncertain-");
  const env = environment(root);
  await fs.mkdir(env.OPENCLAW_STATE_DIR!, { recursive: true });
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, "{}\n");
  const result = await runCliProcessChild({
    nodeArgs: [...entrypoint, "migrate-uncertain"],
    env,
  });
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    applyCompleted: true,
    uncertain: true,
    ownsState: true,
    laterMutationRan: false,
    laterRefused: true,
  });
  const recovered = await runCliProcessChild({
    nodeArgs: [...entrypoint, "exec-policy", "preset", "cautious", "--json"],
    env,
  });
  expect(recovered.code, recovered.stderr).toBe(0);
  expect(JSON.parse(recovered.stdout)).toMatchObject({
    preset: "cautious",
    approvalsExists: true,
  });
});
