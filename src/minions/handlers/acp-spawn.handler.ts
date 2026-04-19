import type { MinionHandler, MinionJobContext } from "../types.js";
import { UnrecoverableError } from "../types.js";

export const acpSpawnHandler: MinionHandler = async (job: MinionJobContext) => {
  const { sessionKey } = job.data as { sessionKey?: string };
  if (!sessionKey) {
    throw new UnrecoverableError("acp.spawn handler requires sessionKey in job.data");
  }

  // TODO(minions): Wire to actual ACP spawn internals.
  return {
    sessionKey,
    status: "stub",
    message: "acp.spawn handler not yet wired to ACP spawn internals",
  };
};

export const ACP_SPAWN_HANDLER_NAME = "acp.spawn";
