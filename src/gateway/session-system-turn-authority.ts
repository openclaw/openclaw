import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { ReplyOperation } from "../sessions/session-controller.contracts.js";
import { getSessionControllerEntryForOperation } from "../sessions/session-controller.identity.js";
import type { QueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";
import {
  prepareSessionPrincipalRunAuthority,
  prepareSessionParticipationRun,
} from "./session-principal-run-authority.js";
import { resolveSessionSystemTurnProfileId } from "./session-sharing-authorization-async.js";

/** Capture the interrupted execution's source, never a later steering participant. */
export function captureSessionRestartOperatorSource(
  operation: ReplyOperation,
): QueuedOperatorRecoverySource | undefined {
  try {
    const requester = operation.personalToolParticipants?.resolve(undefined, {
      allowTurnOwner: () => true,
    });
    if (requester) {
      return captureQueuedOperatorRecoverySource(requester.operatorAuthority);
    }
    const claim = getSessionControllerEntryForOperation(operation).mailbox?.claim;
    const sources =
      claim?.operation === operation && !claim.released && !claim.releaseRequested
        ? claim.sources
        : [];
    return sources.length > 1
      ? { kind: "unavailable" }
      : captureQueuedOperatorRecoverySource(sources[0]?.operatorAuthority);
  } catch {
    // A failed known source cannot fall back to the session principal.
    return { kind: "unavailable" };
  }
}

/** Captured restart requesters retain their source; unattributed inputs use the session principal. */
export async function prepareSessionSystemTurnAuthority(
  params: Omit<
    Parameters<typeof prepareSessionPrincipalRunAuthority>[0],
    "profileId" | "sessionPrincipal" | "recoveredOperatorAuthority"
  > & { operatorSource?: QueuedOperatorRecoverySource },
) {
  const entry = await readSessionEntryReadOnlyInWorker(
    {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      projection: "list",
    },
    params.assertCurrent,
  );
  if (entry?.sessionId !== params.sessionId) {
    throw new Error("System turn session is unavailable or has changed.");
  }
  const participation = await prepareSessionParticipationRun({
    context: params.context,
    agentId: params.agentId,
    entry,
    turnCeiling: params.participationCeiling,
    assertCurrent: params.assertCurrent,
  });
  if (participation) {
    return participation;
  }
  if (params.operatorSource) {
    const restored = await restoreGatewayQueuedOperatorRecovery({
      source: params.operatorSource,
      context: params.context,
      assertCurrent: () => params.assertCurrent?.(),
    });
    try {
      return await prepareSessionPrincipalRunAuthority({
        ...params,
        profileId: restored.authority.profileId,
        recoveredOperatorAuthority: restored.authority,
        preserveRecordedSource: true,
      });
    } finally {
      restored.release();
    }
  }
  const profileId = resolveSessionSystemTurnProfileId(entry);
  return profileId
    ? prepareSessionPrincipalRunAuthority({ ...params, profileId, sessionPrincipal: true })
    : undefined;
}
