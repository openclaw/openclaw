import type { MinionHandler, MinionJobContext } from "../types.js";
import { UnrecoverableError } from "../types.js";

export const cronTickHandler: MinionHandler = async (job: MinionJobContext) => {
  const { cronId, expression } = job.data as { cronId?: string; expression?: string };
  if (!cronId) {
    throw new UnrecoverableError("cron.tick handler requires cronId in job.data");
  }

  // TODO(minions): Wire to actual cron tick execution.
  return {
    cronId,
    expression,
    status: "stub",
    message: "cron.tick handler not yet wired to cron execution internals",
  };
};

export const CRON_TICK_HANDLER_NAME = "cron.tick";
