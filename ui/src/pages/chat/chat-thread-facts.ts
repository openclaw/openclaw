import { composeTranscriptDisplay } from "../../../../src/chat/transcript-display-position.js";
import { isAssistantHeartbeatAckForDisplay } from "../../lib/chat/heartbeat-display.ts";
import { activeChatReasoning } from "./chat-reasoning.ts";
import type { BuildChatItemsProps } from "./chat-thread-contract.ts";
import type { ReplyAttributionFacts } from "./chat-thread-grouping.ts";
import {
  isKeyedAssistantStreamFallbackMessage,
  transcriptRunId,
} from "./chat-thread-run-identity.ts";

/**
 * Transcript-wide facts of one build. An older-page prepend reuses retained rows
 * only while the new page cannot change them (see chat-thread-prepend.ts).
 */
export type ChatItemsFacts = ReplyAttributionFacts & {
  /** Display history after heartbeat/commentary filtering and composition. */
  history?: readonly unknown[];
  /** First history message owning each persisted canvas identity or inline view key. */
  firsts: Map<string, unknown>;
  /** History messages whose divider key includes their transcript index. */
  indexedDividers: unknown[];
  /** Model-selection state entering this message. */
  probe?: unknown;
  modelBefore?: string;
};

/** Messages the transcript displays, in display order. */
export function displayChatHistory(
  props: { messages: unknown[]; persistCommentary?: boolean },
  activeCommentaryRunId?: string,
): unknown[] {
  return composeTranscriptDisplay(
    props.messages.filter(
      (message) =>
        !isAssistantHeartbeatAckForDisplay(message) &&
        (props.persistCommentary !== false ||
          !isKeyedAssistantStreamFallbackMessage(message) ||
          (activeCommentaryRunId !== undefined &&
            transcriptRunId(message) === activeCommentaryRunId)),
    ),
  );
}

export function sameFields<T extends object>(
  previous: T | null | undefined,
  next: T | null | undefined,
  fields: readonly (keyof T)[],
): boolean {
  return fields.every((field) => previous?.[field] === next?.[field]);
}

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
          sameFields(previousActive, nextActive, ["itemId", "startedAt"])),
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
    previous.runWorking === next.runWorking &&
    previous.runFinalizing === next.runFinalizing &&
    previous.runActive === next.runActive &&
    previous.subagentWait?.startedAt === next.subagentWait?.startedAt &&
    previous.subagentWait?.runId === next.subagentWait?.runId &&
    (previous.subagentWait === undefined) === (next.subagentWait === undefined) &&
    previous.questionPrompts === next.questionPrompts &&
    // Settled history keeps its rows while refresh loading changes; active runs
    // still need loading transitions to update their progress presentation.
    (previous.loading === next.loading || (!next.runWorking && !next.subagentWait)) &&
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
