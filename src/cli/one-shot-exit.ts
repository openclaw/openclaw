import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

function isVitestEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    env.VITEST === "true" ||
    env.VITEST === "1" ||
    env.VITEST_POOL_ID !== undefined ||
    env.VITEST_WORKER_ID !== undefined
  );
}

export function shouldForceExitAfterOneShotOutput(
  runtime: RuntimeEnv = defaultRuntime,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return runtime === defaultRuntime && !isVitestEnv(env);
}

export function exitAfterOneShotOutput(
  runtime: RuntimeEnv = defaultRuntime,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!shouldForceExitAfterOneShotOutput(runtime, env)) {
    return;
  }

  const exit = () => runtime.exit(0);
  if (process.stdout.writableLength > 0) {
    process.stdout.write("", exit);
    return;
  }
  setImmediate(exit);
}
