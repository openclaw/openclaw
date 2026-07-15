/** Resolves create-time default delivery for new cron jobs. */
import type { CronDelivery, CronJobCreate } from "../types.js";

/**
 * Resolves default cron delivery for new jobs when callers omit explicit delivery config.
 * This is the direct-service contract: supported creation paths (gateway `cron.add`,
 * agent cron tool) already fill delivery in `normalizeCronJobCreate`, so this default
 * only governs callers that reach `CronService.add`/declarative convergence directly.
 * Keep the isolated-like target set (`isolated`, `current`, `session:<id>`) consistent
 * with `src/cron/normalize.ts` and `src/cron/delivery-plan.ts`; otherwise jobs created
 * through those callers silently lose the announce default and their results never
 * reach the initiating session.
 */
export function resolveInitialCronDelivery(input: CronJobCreate): CronDelivery | undefined {
  if (input.delivery) {
    return input.delivery;
  }
  if (
    (input.sessionTarget === "isolated" ||
      input.sessionTarget === "current" ||
      (typeof input.sessionTarget === "string" && input.sessionTarget.startsWith("session:"))) &&
    (input.payload.kind === "agentTurn" || input.payload.kind === "command")
  ) {
    return { mode: "announce" };
  }
  return undefined;
}
