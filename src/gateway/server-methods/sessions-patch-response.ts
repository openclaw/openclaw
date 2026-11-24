import type { SessionsPatchManyResult } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionPatchTargetIdentity } from "./session-unread-ack.js";
import type { MutationOutcome } from "./sessions-patch-types.js";

/** A batch returns one receipt per original target, never its internal entry or private writer state. */
export function projectSessionPatchManyResult(
  targets: readonly SessionPatchTargetIdentity[],
  outcomes: readonly MutationOutcome[],
): SessionsPatchManyResult {
  return {
    outcomes: outcomes.map((outcome, index) => {
      const target = targets[index]!;
      const identity = { key: target.key, ...(target.agentId ? { agentId: target.agentId } : {}) };
      return outcome.ok
        ? {
            ok: true,
            ...identity,
            ...(outcome.archiveUndoToken ? { archiveUndoToken: outcome.archiveUndoToken } : {}),
          }
        : { ok: false, ...identity, error: outcome.error };
    }),
  };
}
