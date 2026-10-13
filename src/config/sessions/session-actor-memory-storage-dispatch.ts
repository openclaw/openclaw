import {
  readSessionActorBoardQuery,
  executeSessionActorBoardCommand,
} from "../../boards/session-actor-board-memory.js";
import {
  readSessionActorProgressCard,
  executeSessionActorProgressCardCommand,
} from "../../session-cards/session-actor-progress-card-memory.js";
import { SessionGoalOperationError } from "./goals-operations.types.js";
import {
  readSessionActorMemoryCollaboration,
  mutateSessionActorMemoryCollaboration,
} from "./session-actor-memory-collaboration.js";
import { readSessionActorMemoryCompletion } from "./session-actor-memory-completion.js";
import {
  readSessionActorMemoryConversationDelivery,
  beginSessionActorMemoryConversationDelivery,
  transitionSessionActorMemoryConversationDelivery,
} from "./session-actor-memory-conversation-delivery.js";
import {
  readSessionActorMemoryConversation,
  writeSessionActorMemoryConversation,
} from "./session-actor-memory-conversation.js";
import { readSessionActorMemoryCorpus } from "./session-actor-memory-corpus.js";
import {
  readSessionActorMemoryEntryQuery,
  executeSessionActorMemoryEntryCommand,
} from "./session-actor-memory-entry.js";
import {
  readSessionActorMemoryForkQuery,
  executeSessionActorMemoryForkCommand,
} from "./session-actor-memory-fork.js";
import { createSessionActorMemoryGoals } from "./session-actor-memory-goals.js";
import { readSessionActorMemoryHistoryQuery } from "./session-actor-memory-history-read.js";
import { createSessionActorMemoryMetadata } from "./session-actor-memory-metadata.js";
import { createSessionActorMemoryPending } from "./session-actor-memory-pending.js";
import { executeSessionActorMemoryReportCommand } from "./session-actor-memory-reports.js";
import { readSessionActorMemorySearch } from "./session-actor-memory-search.js";
import {
  readSessionActorMemorySideEffects,
  mutateSessionActorMemorySideEffects,
} from "./session-actor-memory-side-effects.js";
import {
  resolveSessionActorMemoryWindow,
  type SessionActorMemoryWindow,
} from "./session-actor-memory-state.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import { prepareSessionActorMemoryTurn } from "./session-actor-memory-turn-prepare.js";
import {
  readSessionActorMemoryUsage,
  mutateSessionActorMemoryUsage,
} from "./session-actor-memory-usage.js";
import type {
  SessionActorStorageAuthority,
  SessionActorStorageCommand,
  SessionActorStorageQuery,
} from "./session-actor-storage-contract.js";

export function readSessionActorMemoryStorage(
  context: SessionActorMemoryStorageContext,
  query: SessionActorStorageQuery,
) {
  switch (query.type) {
    case "session.conversation.read":
    case "session.conversation.authority":
      return readSessionActorMemoryConversation(context, query);
    case "session.conversation.delivery.read":
      return readSessionActorMemoryConversationDelivery(context, query.input);
    case "session.members.read":
    case "session.participants.read":
    case "session.suggestions.read":
    case "session.reactions.read":
      return readSessionActorMemoryCollaboration(context, query);
    case "session.outbox.listPendingSessions":
    case "session.outbox.readNextPending":
    case "session.outbox.hasPending":
    case "session.trajectory.read":
    case "session.trajectory.rows":
      return readSessionActorMemorySideEffects(context, query);
    case "boards.snapshot":
    case "boards.document":
      return readSessionActorBoardQuery(context, query);
    case "progressCard.get":
      return readSessionActorProgressCard(context, query.input.sessionKey);
    case "session.report.prepare":
    case "session.correction.prepare":
    case "session.transcript.messageFacts":
      return executeSessionActorMemoryReportCommand(context, query);
    case "session.memory.targets":
    case "session.corpus.list":
    case "session.usage.snapshot":
      return readSessionActorMemoryUsage(context, query);
    case "session.memory.entry":
    case "session.memory.resetRecall":
      return readSessionActorMemoryCorpus(context, query);
    case "session.history.search":
      return readSessionActorMemorySearch(context, query.input);
    case "session.completion.read":
      return readSessionActorMemoryCompletion(context.state, query.input, context);
    case "session.turn.prepare":
      return prepareSessionActorMemoryTurn(context, query.input);
    case "session.entry.creation":
    case "session.entry.read":
    case "session.entry.readById":
    case "session.entries.read":
      return readSessionActorMemoryEntryQuery(context, query);
    case "session.parentFork.source":
      return readSessionActorMemoryForkQuery(context, query);
    case "session.metadata.mutation":
      return createSessionActorMemoryMetadata(context).execute(query);
    case "session.pendingInput.read":
      return createSessionActorMemoryPending(context.state, context).read(query.input);
    case "session.pendingInput.history": {
      const window = resolveSessionActorMemoryWindow(context.state, query.input.sessionId);
      if (!window) {
        return { rows: [], total: 0 };
      }
      const result = createSessionActorMemoryPending(window, context).history(query.input);
      return { ...result, currentSessionId: context.state.hot.entry?.sessionId };
    }
    case "session.pendingInput.receipts": {
      const window = resolveSessionActorMemoryWindow(context.state, query.input.sessionId);
      return createSessionActorMemoryPending(window ?? context.state, context).receipts(
        query.input,
      );
    }
    case "session.goal.receipt": {
      if (query.input.sessionKey !== context.state.hot.target.sessionKey) {
        throw new Error("Goal receipt does not target this session actor");
      }
      const window = resolveSessionActorMemoryWindow(context.state, query.input.expectedSessionId);
      const receipt =
        window &&
        createSessionActorMemoryGoals({ ...context, state: window }).readReceipt(
          query.input.expectedSessionId,
          query.input.operation,
        );
      if (receipt && query.input.expectedSessionId !== context.state.hot.entry?.sessionId) {
        throw new SessionGoalOperationError(
          "session-rebound",
          "Session changed after the Goal operation",
        );
      }
      return receipt;
    }
    default:
      return readSessionActorMemoryHistoryQuery(context.state, query, context);
  }
}

function editPendingWindow(
  context: SessionActorMemoryStorageContext,
  sessionId: string,
): SessionActorMemoryWindow {
  if (context.state.hot.entry?.sessionId === sessionId) {
    return context.state;
  }
  const window = context.state.historicalWindows.get(sessionId);
  if (!window) {
    throw new Error("Pending input window no longer belongs to this session actor");
  }
  const working = {
    ...window,
    hot: structuredClone(window.hot),
    pendingInputs: new Map(window.pendingInputs),
    completions: new Map(window.completions),
  };
  context.state.historicalWindows.set(sessionId, working);
  return working;
}

export function mutateSessionActorMemoryStorage(
  context: SessionActorMemoryStorageContext,
  command: SessionActorStorageCommand,
  authority: SessionActorStorageAuthority,
) {
  switch (command.type) {
    case "session.conversation.register":
      return writeSessionActorMemoryConversation(context, command);
    case "session.conversation.delivery.begin":
      return beginSessionActorMemoryConversationDelivery(context, command.input);
    case "session.conversation.delivery.transition":
      return transitionSessionActorMemoryConversationDelivery(context, command.input);
    case "session.collaboration.add":
    case "session.collaboration.remove":
    case "session.collaboration.participant":
    case "session.collaboration.owner.assign":
    case "session.collaboration.suggestion.add":
    case "session.collaboration.suggestion.claim":
    case "session.collaboration.suggestion.release":
    case "session.collaboration.suggestion.finalize":
    case "session.collaboration.involvement":
    case "session.category.apply":
    case "session.reaction.set":
      return mutateSessionActorMemoryCollaboration(context, command);
    case "session.outbox.prepareRun":
    case "session.outbox.enqueueIntent":
    case "session.outbox.acceptIntent":
    case "session.outbox.publishClosedTurn":
    case "session.outbox.complete":
    case "session.outbox.recordFailure":
    case "session.outbox.discardIntent":
    case "session.heartbeat.persist":
    case "session.heartbeat.claim":
    case "session.messageToolOutcome.record":
    case "session.trajectory.append":
      return mutateSessionActorMemorySideEffects(context, command);
    case "boards.applyOps":
    case "boards.putWidget":
    case "boards.grant":
      return executeSessionActorBoardCommand(context, command);
    case "progressCard.put":
    case "progressCard.clearForReset":
      return executeSessionActorProgressCardCommand(context, command);
    case "session.report.assistant":
    case "session.report.abortedPartial":
    case "session.report.append":
    case "session.correction.commit":
    case "session.workerTranscript.commit":
      return executeSessionActorMemoryReportCommand(context, command);
    case "session.usage.write":
      return mutateSessionActorMemoryUsage(context, command);
    case "session.entry.create":
    case "session.entry.patch":
    case "session.entry.replace":
    case "session.entry.replacements":
    case "session.lifecycle.reset":
    case "session.lifecycle.delete":
    case "session.lifecycle.reclaim":
      return executeSessionActorMemoryEntryCommand(context, command);
    case "session.parentFork.commit":
    case "session.messageCut":
      return executeSessionActorMemoryForkCommand(context, command);
    case "session.pendingInput.mutate": {
      const window =
        command.input.kind === "finish"
          ? editPendingWindow(context, command.input.sessionId)
          : context.state;
      return createSessionActorMemoryPending(window, context).mutate(command.input);
    }
    case "session.pendingInput.interruptHistory": {
      if (!authority.isPendingInputProtected) {
        throw new Error("Pending input reconciliation requires its live custody owner");
      }
      const window = editPendingWindow(context, command.input.sessionId);
      return createSessionActorMemoryPending(window, context).interruptHistory(command.input, {
        isProtected: (candidate) =>
          authority.isPendingInputProtected!(candidate, context.state.hot.entry?.sessionId),
        admit: (stage, grant) =>
          context.admit(stage, { ...grant, currentSessionId: context.state.hot.entry?.sessionId }),
      });
    }
    case "session.goal.mutate":
      return createSessionActorMemoryGoals(context).mutate(command.input);
    default:
      return createSessionActorMemoryMetadata(context).execute(command);
  }
}
