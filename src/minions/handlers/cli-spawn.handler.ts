import type { MinionHandler, MinionJobContext } from "../types.js";
import { UnrecoverableError } from "../types.js";

export const cliSpawnHandler: MinionHandler = async (job: MinionJobContext) => {
  const { runId } = job.data as { runId?: string };
  if (!runId) {
    throw new UnrecoverableError("cli.spawn handler requires runId in job.data");
  }

  // Stub: wire to actual CLI runner spawn internals.
  return {
    runId,
    status: "stub",
    message: "cli.spawn handler not yet wired to CLI spawn internals",
  };
};

export const CLI_SPAWN_HANDLER_NAME = "cli.spawn";
