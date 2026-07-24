// Plugin lifecycle command wrapper defers process exits until the shared lease is released.
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { ExitError, type RuntimeEnv, type RuntimeExitOptions } from "../runtime.js";

export async function withPluginLifecycleCommandLease<T>(
  runtime: RuntimeEnv,
  run: (runtime: RuntimeEnv) => Promise<T>,
): Promise<T> {
  let exitOptions: RuntimeExitOptions | undefined;
  const deferredExitRuntime: RuntimeEnv = {
    ...runtime,
    exit: (code, options) => {
      exitOptions = options;
      throw new ExitError(code);
    },
  };

  try {
    return await withPluginLifecycleLease({}, async () => await run(deferredExitRuntime));
  } catch (error) {
    if (error instanceof ExitError) {
      runtime.exit(error.code, exitOptions);
      throw error;
    }
    throw error;
  }
}
