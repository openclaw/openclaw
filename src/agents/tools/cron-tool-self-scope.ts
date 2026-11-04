import { readToolStringParam } from "./common.js";
import type { CronToolOptions } from "./cron-tool.types.js";

const CRON_SELF_REMOVE_SCOPE_ERROR = "Automations tool is restricted to the current automation.";

export function readCronSelfRemoveOnlyJobId(opts: CronToolOptions | undefined) {
  return opts?.selfRemoveOnlyJobId?.trim() || undefined;
}

/** A self-scoped automation run may act only on its own job. */
export function assertCronSelfRemoveScope(
  opts: CronToolOptions | undefined,
  action: string,
  params: Record<string, unknown>,
) {
  const selfRemoveOnlyJobId = readCronSelfRemoveOnlyJobId(opts);
  if (!selfRemoveOnlyJobId || action === "status" || action === "list") {
    return;
  }
  const invocationAction = ["next_check", "scratch_get", "scratch_set", "record_result"].includes(
    action,
  );
  if (invocationAction || ["get", "remove", "runs"].includes(action)) {
    const id = readToolStringParam(params, "jobId") ?? readToolStringParam(params, "id");
    if (id === selfRemoveOnlyJobId || (invocationAction && !id)) {
      return;
    }
  }
  throw new Error(CRON_SELF_REMOVE_SCOPE_ERROR);
}
