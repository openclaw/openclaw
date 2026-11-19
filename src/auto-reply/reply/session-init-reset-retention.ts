// Continuation (karmaterminal): reply-session init's hooks for an explicit reset's retention of
// its continuation-elected delegate tree (../continuation/session-reset-retention.ts). A rollover
// that is not an explicit reset gets inert hooks, so session init calls each one unconditionally.
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareContinuationResetRetention } from "../continuation/session-reset-retention.js";
import { stopSessionResetWork } from "./session-reset-cleanup.js";

type ResetSuccessor = { nextLifecycleRevision?: string };

export function prepareResetRetention(
  cfg: OpenClawConfig,
  candidate: { resetTriggered: boolean; sessionKey: string },
  target: { agentId: string; storePath: string },
) {
  const retention = candidate.resetTriggered
    ? prepareContinuationResetRetention({
        cfg,
        sessionKey: candidate.sessionKey,
        agentId: target.agentId,
        storePath: target.storePath,
      })
    : undefined;
  return {
    /** Upstream's chat reset stop; an explicit reset first marks the runs it retains. */
    stopSubagents: (
      fromRevision: string | undefined,
      params: Parameters<typeof stopSessionResetWork>[0],
    ) =>
      retention
        ? retention.stopSubagents({ fromRevision, assertCurrent: params.assertCurrent }, () =>
            stopSessionResetWork(params),
          )
        : stopSessionResetWork(params),
    /** The commit's lifecycle identity, carrying the successor revision the marks name. */
    withSuccessor: <T extends object>(identity: T): T & ResetSuccessor =>
      retention ? { ...identity, nextLifecycleRevision: retention.successorRevision } : identity,
    /** Settles the marks; runs inside the lifecycle mutation, so no later rollover moves the row. */
    resolve: async () => await retention?.resolve(),
  };
}

/** The replacing session's revision: a matched reset adopts the successor its marks name. */
export function resetSuccessorRevision(
  lifecycleMutationMatches: boolean,
  identity: ResetSuccessor | undefined,
): string {
  return (lifecycleMutationMatches ? identity?.nextLifecycleRevision : undefined) ?? randomUUID();
}
