import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { OpenClawStateReadOptions } from "../state/openclaw-state-read.types.js";
import type { ClawRemoveFacts } from "./remove-facts.kernel.js";

export async function readClawRemoveFacts(
  agentId: string,
  sessionStorePaths: readonly string[],
  options: OpenClawStateDatabaseOptions = {},
  readOptions?: OpenClawStateReadOptions,
): Promise<ClawRemoveFacts> {
  const reply = await executeExistingOpenClawStateRead(
    options,
    { type: "claws.removeFacts", agentId, sessionStorePaths: [...sessionStorePaths] },
    readOptions,
  );
  if (!reply || !reply.ok || reply.type !== "claws.removeFacts") {
    throw new Error("Claw removal safety facts could not be read.");
  }
  return reply.facts;
}
