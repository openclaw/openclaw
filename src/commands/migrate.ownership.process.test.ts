import fs from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runStateOwnerCli, stateOwnerEnv } from "../cli/cli-process-fixture.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

it("retains and seals migration ownership after uncertain child cleanup until process exit", async () => {
  const root = roots.make("openclaw-migration-uncertain-");
  const env = stateOwnerEnv(root);
  await fs.mkdir(env.OPENCLAW_STATE_DIR!, { recursive: true });
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, "{}\n");
  const result = await runStateOwnerCli(env, ["migrate-uncertain"]);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    applyCompleted: true,
    uncertain: true,
    ownsState: true,
    laterMutationRan: false,
    laterRefused: true,
  });
  const recovered = await runStateOwnerCli(env, ["exec-policy", "preset", "cautious", "--json"]);
  expect(recovered.code, recovered.stderr).toBe(0);
  expect(JSON.parse(recovered.stdout)).toMatchObject({
    preset: "cautious",
    approvalsExists: true,
  });
});
