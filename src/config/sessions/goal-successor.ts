import type { SessionGoalSuccessor } from "./goal-successor.types.js";
import { accountSessionGoalUsage, buildUpdatedSessionGoalStatus } from "./goals-transitions.js";
import { applySessionEntryReplacements } from "./session-accessor.js";
import type { InternalSessionEntry } from "./types.js";

export function isSessionGoalSuccessorCurrent(
  entry: InternalSessionEntry | undefined,
  successor: SessionGoalSuccessor,
): boolean {
  const goal = entry && accountSessionGoalUsage(entry, Date.now());
  return Boolean(
    entry &&
    entry.sessionId === successor.sessionId &&
    entry.lifecycleRevision === successor.lifecycleRevision &&
    goal?.id === successor.goalId &&
    goal.status === "active" &&
    !entry.archivedAt,
  );
}

type Target = { agentId: string; sessionKey: string; storePath: string };

/** Commit before releasing the predecessor or publishing its in-memory successor. */
export async function persistSessionGoalSuccessor(
  target: Target,
  successor: SessionGoalSuccessor,
  assertCurrent: () => void,
): Promise<boolean> {
  return applySessionEntryReplacements({
    ...target,
    sessionKeys: [target.sessionKey],
    requireWriteSuccess: true,
    assertCommitAllowed: assertCurrent,
    update: (rows) => {
      assertCurrent();
      const entry = rows.find((row) => row.sessionKey === target.sessionKey)?.entry;
      if (!isSessionGoalSuccessorCurrent(entry, successor) || !entry) {
        return { result: false };
      }
      return {
        result: true,
        replacements: [
          { sessionKey: target.sessionKey, entry: { ...entry, goalSuccessor: successor } },
        ],
      };
    },
  });
}

/** Ordinary adoption may reopen restart-interrupted execution, never a stopped pursuit. */
export async function prepareSessionGoalSuccessorExecution(
  target: Target,
  successor: SessionGoalSuccessor,
  assertCurrent: () => void,
): Promise<void> {
  await applySessionEntryReplacements({
    ...target,
    sessionKeys: [target.sessionKey],
    requireWriteSuccess: true,
    assertCommitAllowed: assertCurrent,
    update: (rows) => {
      assertCurrent();
      const entry = rows.find((row) => row.sessionKey === target.sessionKey)?.entry;
      if (
        !entry ||
        entry.goalSuccessor?.id !== successor.id ||
        !isSessionGoalSuccessorCurrent(entry, successor)
      ) {
        throw new Error("Goal successor changed before execution admission.");
      }
      if (!entry.abortedLastRun) {
        return { result: undefined };
      }
      if (entry.status !== "killed" || entry.lifecycleRunId) {
        throw new Error("Goal successor has not settled its interrupted execution.");
      }
      // Stop clears the receipt; error/Pause/terminal transitions clear the active Goal.
      // Only the exact surviving pursuit may clear the prior execution's abort bit.
      // Keep its terminal history until the newly admitted execution actually starts.
      return {
        result: undefined,
        replacements: [
          { sessionKey: target.sessionKey, entry: { ...entry, abortedLastRun: false } },
        ],
      };
    },
  });
}

/** A late predecessor must never dispose of a newer input's custody. */
export async function retireSessionGoalSuccessor(
  target: Target,
  successor: SessionGoalSuccessor,
  assertCurrent: () => void,
  refusal?: string,
): Promise<void> {
  await applySessionEntryReplacements({
    ...target,
    sessionKeys: [target.sessionKey],
    requireWriteSuccess: true,
    assertCommitAllowed: assertCurrent,
    update: (rows) => {
      const entry = rows.find((row) => row.sessionKey === target.sessionKey)?.entry;
      if (entry?.sessionId !== successor.sessionId || entry.goalSuccessor?.id !== successor.id) {
        return { result: undefined };
      }
      return {
        result: undefined,
        replacements: [
          {
            sessionKey: target.sessionKey,
            entry: {
              ...entry,
              goalSuccessor: undefined,
              ...(refusal && entry.goal?.id === successor.goalId && entry.goal.status === "active"
                ? {
                    goal: buildUpdatedSessionGoalStatus(
                      entry,
                      { status: "paused", note: refusal },
                      Date.now(),
                    ),
                  }
                : {}),
            },
          },
        ],
      };
    },
  });
}
