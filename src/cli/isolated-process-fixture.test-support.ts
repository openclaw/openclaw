import fs from "node:fs/promises";
import path from "node:path";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

export function createCliProcessFixture(
  root: string,
  overrides: NodeJS.ProcessEnv,
  entrypoint: Parameters<typeof resolveRuntimeWorkerUrl>[0] = cliRecoveryEntrypoints.cli,
) {
  const configPath = path.join(root, "openclaw.json");
  const entryArgs = resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(entrypoint));
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_NO_RESPAWN: "1",
    ...overrides,
  };
  return {
    env,
    configPath,
    writeConfig: (config: unknown) => fs.writeFile(configPath, JSON.stringify(config)),
    run: (args: string[], interact?: Parameters<typeof runCliProcessChild>[0]["interact"]) =>
      runCliProcessChild({ nodeArgs: [...entryArgs, ...args], env, interact }),
  };
}
