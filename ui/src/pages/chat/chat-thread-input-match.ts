import { activeChatReasoning } from "./chat-reasoning.ts";
import type { BuildChatItemsProps } from "./chat-thread-build.ts";

export function sameEntries<T>(previous?: readonly T[], next?: readonly T[]): boolean {
  return (
    previous === next ||
    (previous !== undefined &&
      next !== undefined &&
      previous.length === next.length &&
      previous.every((entry, index) => entry === next[index]))
  );
}

export function sameChatItemsStructuralInput(
  previous: BuildChatItemsProps,
  next: BuildChatItemsProps,
  ignoreWorkingPhase = false,
  hasContentBeforeProgress = false,
): boolean {
  const previousReasoning = previous.reasoning?.items;
  const nextReasoning = next.reasoning?.items;
  const previousActive = activeChatReasoning(previous.reasoning);
  const nextActive = activeChatReasoning(next.reasoning);
  return (
    previous.sessionKey === next.sessionKey &&
    previous.archiveNotice?.key === next.archiveNotice?.key &&
    previous.archiveNotice?.label === next.archiveNotice?.label &&
    previous.runId === next.runId &&
    previous.compactionStatus === next.compactionStatus &&
    previous.locale === next.locale &&
    previous.messages === next.messages &&
    previous.toolMessages === next.toolMessages &&
    previous.guardianNotices === next.guardianNotices &&
    previous.streamSegments === next.streamSegments &&
    previous.streamStartedAt === next.streamStartedAt &&
    previous.reasoning?.runId === next.reasoning?.runId &&
    previous.showReasoning === next.showReasoning &&
    previousReasoning?.length === nextReasoning?.length &&
    (previousReasoning?.every(
      (item, index) =>
        item === nextReasoning?.[index] ||
        (item === previousActive &&
          nextReasoning?.[index] === nextActive &&
          previousActive?.itemId === nextActive?.itemId &&
          previousActive?.startedAt === nextActive?.startedAt),
    ) ??
      true) &&
    previous.queue === next.queue &&
    previous.initialTurnId === next.initialTurnId &&
    // renderChat derives this list of immutable Gateway records on every render,
    // including scroll-driven ones; identity would rebuild all loaded history.
    sameEntries(previous.pendingInputs, next.pendingInputs) &&
    previous.workspaceSyncPendingRunIds === next.workspaceSyncPendingRunIds &&
    previous.workerSetupPending === next.workerSetupPending &&
    previous.showToolCalls === next.showToolCalls &&
    previous.persistCommentary === next.persistCommentary &&
    (ignoreWorkingPhase ||
      (previous.runWorking === next.runWorking && previous.runFinalizing === next.runFinalizing)) &&
    previous.runActive === next.runActive &&
    previous.subagentWait?.startedAt === next.subagentWait?.startedAt &&
    previous.subagentWait?.runId === next.subagentWait?.runId &&
    (previous.subagentWait === undefined) === (next.subagentWait === undefined) &&
    previous.questionPrompts === next.questionPrompts &&
    // Reuse the builder's pre-progress content fact; raw history may be hidden.
    (previous.loading === next.loading ||
      hasContentBeforeProgress ||
      (!next.runWorking && !next.subagentWait)) &&
    sameEntries(previous.replyPeople, next.replyPeople) &&
    previous.replyLocalPerson === next.replyLocalPerson &&
    previous.searchOpen === next.searchOpen &&
    previous.searchQuery === next.searchQuery &&
    previous.messageRecovery?.messages === next.messageRecovery?.messages &&
    previous.messageRecovery?.revision === next.messageRecovery?.revision &&
    previous.messageRecovery?.displayFacts === next.messageRecovery?.displayFacts &&
    previous.messageRecovery?.canFetchFullMessage === next.messageRecovery?.canFetchFullMessage &&
    previous.messageRecovery?.agentId === next.messageRecovery?.agentId
  );
}
