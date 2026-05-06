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
  let pendingStreams = 0;

  const maybeDrain = (stream: NodeJS.WriteStream) => {
    if (stream.writableLength <= 0) {
      return;
    }
    pendingStreams += 1;
    stream.write("", () => {
      pendingStreams -= 1;
      if (pendingStreams === 0) {
        exit();
      }
    });
  };

  maybeDrain(process.stdout);
  maybeDrain(process.stderr);

  if (pendingStreams > 0) {
    return;
  }
  setImmediate(exit);
}
