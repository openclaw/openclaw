import { spawnSync } from "node:child_process";
import path from "node:path";
import { resolveVitestNodeArgs } from "../scripts/lib/vitest-process-env.mts";

export function runBuiltCli(
  tempHome: string,
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
  options: { inheritEnvironment?: boolean; execArgv?: string[] } = {},
) {
  const env: NodeJS.ProcessEnv = {
    ...(options.inheritEnvironment === false ? { PATH: process.env.PATH } : process.env),
    HOME: tempHome,
    USERPROFILE: tempHome,
    OPENCLAW_TEST_FAST: "1",
  };
  delete env.OPENCLAW_HOME;
  delete env.OPENCLAW_STATE_DIR;
  delete env.OPENCLAW_CONFIG_PATH;
  delete env.VITEST;
  Object.assign(env, envOverrides);

  const entry = path.resolve(process.cwd(), "openclaw.mjs");
  // Without the runner's V8 policy, process.exit can deadlock joining a background
  // compiler that waits for main-thread GC; spawnSync then reports status null.
  const nodeArgs = process.versions.bun ? [] : resolveVitestNodeArgs(env);
  return spawnSync(process.execPath, [...nodeArgs, ...(options.execArgv ?? []), entry, ...args], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
}
