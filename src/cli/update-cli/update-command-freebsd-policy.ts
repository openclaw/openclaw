import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";

/** A continuation names its same CLI run; service discovery grants no authority. */
export function assertFreeBsdUpdateCommandRunOrigin(
  opts: {
    run?: Pick<NonNullable<UpdateCommandOptions["run"]>, "runId">;
  },
  env: NodeJS.ProcessEnv,
  initializedRunId?: string,
): void {
  if (process.platform !== "freebsd") {
    return;
  }
  if (env.OPENCLAW_UPDATE_RUN_HANDOFF === "1") {
    throw new UpdatePreMutationError(
      "freebsd-update-mode",
      "FreeBSD service control is unavailable; invoke the update from its owning CLI without a managed-service handoff.",
    );
  }
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
      "FreeBSD foreground continuation requires the same existing manual CLI update run. Start `openclaw update` without inherited update-run or handoff selectors.",
    );
  }
}
