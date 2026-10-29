import { routeLogsToStderr } from "../logging/console.js";
import type { OpenClawStateOwnershipWorkerReply } from "./openclaw-state-ownership-worker.js";
import {
  inspectOpenClawStateOwnershipInProcess,
  type OpenClawExternalStateOwnership,
} from "./openclaw-state-ownership.js";
import { encodeOpenClawStateWorkerError } from "./openclaw-state-worker-error.js";

function inspect(databasePath: string | undefined): OpenClawStateOwnershipWorkerReply {
  try {
    if (!databasePath) {
      throw new Error("Shared-state ownership worker requires a database path");
    }
    const ownership: OpenClawExternalStateOwnership | null =
      inspectOpenClawStateOwnershipInProcess(databasePath);
    return { ok: true, ownershipJson: JSON.stringify(ownership) };
  } catch (error) {
    const workerError = encodeOpenClawStateWorkerError(error, { includeOrdinary: true });
    if (!workerError) {
      throw error;
    }
    return { ok: false, workerError };
  }
}

// Stdout carries only the JSON reply; raised console levels must not prefix it.
routeLogsToStderr();
process.stdout.write(JSON.stringify(inspect(process.argv[2])));
