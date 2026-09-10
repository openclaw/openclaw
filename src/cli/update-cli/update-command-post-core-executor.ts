import { tryResolveInvocationCwd, type UpdateCommandOptions } from "./shared.js";
import { withPostCoreUpdateExecutor } from "./update-command-post-core-admission.js";
import { prepareUpdateCommand } from "./update-command-run.js";
import { withUpdateInProgressEnv } from "./update-command-service-env.js";

/** Keep child admission ahead of preparation; only the parent opens run history. */
export async function runUpdateCommandWithPostCoreExecutor(
  opts: UpdateCommandOptions,
  operation: (
    admitted: UpdateCommandOptions,
    prepared: Awaited<ReturnType<typeof prepareUpdateCommand>>,
    invocationCwd: string | undefined,
  ) => Promise<void>,
): Promise<void> {
  return withPostCoreUpdateExecutor(opts, async (admitted) => {
    const invocationCwd = tryResolveInvocationCwd();
    const prepared = await withUpdateInProgressEnv(invocationCwd, () =>
      prepareUpdateCommand(admitted),
    );
    if (!prepared.postCoreUpdateResume) {
      return operation(admitted, prepared, invocationCwd);
    }
    return withUpdateInProgressEnv(invocationCwd, async () => {
      const { resumePostCoreUpdate } = await import("./update-execution.runtime.js");
      admitted.run?.executorFence?.assertCurrent();
      await resumePostCoreUpdate({
        root: prepared.discoveredRoot,
        channel: prepared.postCoreUpdateChannel,
        opts: admitted,
        timeoutMs: prepared.timeoutMs ?? 30 * 60_000,
      });
    });
  });
}
