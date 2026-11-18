import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import { readGroupParticipationRun } from "./group-participation-run.js";

/** Refresh participation and prepare any newly approved reply before generation. */
export async function prepareGroupParticipationObservation(params: AgentTurnParams) {
  if (params.admittedTurn) {
    params.recoveryMemoryFlushAttempted = params.admittedTurn.memoryFlushAttempted;
  }
  const participation = readGroupParticipationRun(params.replyOperation);
  if (!participation) {
    return undefined;
  }
  for (;;) {
    await refreshObservation(params, participation);
    const turn = params.admittedTurn;
    if (participation.isObserving || !turn?.prepareForExecution) {
      return participation;
    }
    await turn.prepareForExecution();
    // Compaction may rotate the session; execution consumes the preparation owner's result.
    Object.assign(params.followupRun, turn.queued);
    params.getActiveSessionEntry = turn.session.current;
    params.activeSessionStore = turn.sessionStore;
    params.recoveryMemoryFlushAttempted = turn.memoryFlushAttempted;
    if (turn.preflightError) {
      return participation;
    }
    // Input and consent may have changed while maintenance was running.
  }
}

async function refreshObservation(
  params: AgentTurnParams,
  participation: NonNullable<ReturnType<typeof readGroupParticipationRun>>,
) {
  if (participation.mode === "ordinary") {
    return;
  }
  // Positive decisions also expire when the accepted conversation or config changes.
  if (!participation.isCurrent()) {
    await participation.refresh();
  }
  if (!participation.isObserving) {
    return;
  }
  const recorder = params.followupRun.userTurnTranscriptRecorder;
  if (recorder && !recorder.hasPersisted()) {
    const persisted = await recorder.persistApproved(
      params.sessionKey
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
        : undefined,
    );
    if (!persisted) {
      throw new Error("The group source could not be committed to its session");
    }
  }
  params.replyOperation?.abortSignal.throwIfAborted();
  // Persistence can yield to a consent/config change or accepted group input.
  // Silence is valid only while the assessed conversation still owns it.
  if (!participation.isCurrent()) {
    // The owner restores ordinary policy only if assistance is unavailable.
    await participation.refresh();
  }
}
