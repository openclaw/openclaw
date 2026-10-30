import { recordSessionGoalChanged } from "../../sessions/session-state-events.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestContext } from "./types.js";

/** Publish a committed Goal without turning a notification failure into a mutation failure. */
export async function publishCommittedSessionGoalChange(
  context: GatewayRequestContext,
  change: Parameters<typeof recordSessionGoalChanged>[0],
): Promise<void> {
  try {
    const goalChanged = recordSessionGoalChanged(change);
    try {
      // Fence the projection before yielding; lifecycle custody still joins the event writer.
      emitSessionsChanged(context, {
        sessionKey: change.sessionKey,
        agentId: change.agentId,
        reason: "goal",
      });
    } finally {
      await goalChanged;
    }
  } catch (error) {
    try {
      context.logGateway.warn(`Committed Goal notification failed: ${String(error)}`);
    } catch {
      // Diagnostic failure cannot replace an already committed outcome either.
    }
  }
}
