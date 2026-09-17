import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";

/** Root custody does not authorize automatic or restart-bearing update requests. */
export function assertFreeBsdUpdateCommandMode(
  opts: Pick<UpdateCommandOptions, "restart">,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    process.platform === "freebsd" &&
    (opts.restart !== false || env.OPENCLAW_UPDATE_RUN_HANDOFF === "1")
  ) {
    throw new UpdatePreMutationError(
      "freebsd-update-mode",
      "FreeBSD foreground updates require an explicit manual `openclaw update --no-restart` invocation without a managed-service handoff.",
    );
  }
}

/** Call only after native custody admits this exact environment for read-only inspection. */
export function assertFreeBsdUpdateCommandRunOrigin(
  opts: Pick<UpdateCommandOptions, "restart"> & {
    run?: Pick<NonNullable<UpdateCommandOptions["run"]>, "runId">;
  },
  env: NodeJS.ProcessEnv,
  initializedRunId?: string,
): void {
  if (process.platform !== "freebsd") {
    return;
  }
  assertFreeBsdUpdateCommandMode(opts, env);
  const runIds = [env[UPDATE_RUN_ID_ENV]?.trim(), opts.run?.runId].filter((id): id is string =>
    Boolean(id),
  );
  const runId = runIds[0];
  if (
    (!runId && env[POST_CORE_UPDATE_ENV] === "1") ||
    (runId &&
      ((initializedRunId !== undefined && initializedRunId !== runId) ||
        runIds.some((id) => id !== runId) ||
        getUpdateRun(runId, { env })?.trigger !== "cli"))
  ) {
    throw new UpdatePreMutationError(
      "freebsd-update-mode",
      "FreeBSD foreground continuation requires the same existing manual CLI update run. Start `openclaw update --no-restart` without inherited update-run or handoff selectors.",
    );
  }
}
