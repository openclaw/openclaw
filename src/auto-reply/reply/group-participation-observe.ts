import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { readGroupParticipationRun } from "./group-participation-run.js";

/** Refresh participation before generation, committing input when observing instead. */
export async function prepareGroupParticipationObservation(params: AgentTurnParams) {
  const participation = readGroupParticipationRun(params.replyOperation);
  if (!participation || participation.mode === "ordinary") {
    return undefined;
  }
  // Positive decisions also expire when the accepted conversation or config changes.
  const assessedRevision = participation.snapshot?.revision;
  if (assessedRevision === undefined || !participation.isCurrent(assessedRevision)) {
    await participation.refresh();
  }
  if (!participation.isObserving) {
    return participation;
  }
  const recorder = params.followupRun.userTurnTranscriptRecorder;
  if (participation.isObserving && recorder && !recorder.hasPersisted()) {
    const persisted = await recorder.persistApproved({
      expectedSessionId: params.followupRun.run.sessionId,
      ...(params.sessionKey
        ? {
            target: {
              agentId: params.followupRun.run.agentId,
              sessionId: params.followupRun.run.sessionId,
              sessionKey: params.sessionKey,
              storePath: params.storePath,
              sessionEntry: params.getActiveSessionEntry(),
              sessionStore: params.activeSessionStore,
              config: params.followupRun.run.config,
              cwd: params.followupRun.run.workspaceDir,
            },
          }
        : {}),
    });
    if (!persisted) {
      throw new Error("The group source could not be committed to its session");
    }
  }
  params.replyOperation?.abortSignal.throwIfAborted();
  // Persistence can yield to a consent/config change or accepted group input.
  // Silence is valid only while the assessed conversation still owns it.
  const revision = participation.snapshot?.revision;
  if (revision === undefined || !participation.isCurrent(revision)) {
    // The owner restores ordinary policy only if assistance is unavailable.
    await participation.refresh();
  }
  return participation;
}
