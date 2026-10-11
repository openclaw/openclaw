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
import {
  resolveSessionActorMemoryWindow,
  type SessionActorMemoryWindow,
} from "./session-actor-memory-state.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
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
      return (
        window &&
        createSessionActorMemoryGoals({ ...context, state: window }).readReceipt(
          query.input.expectedSessionId,
          query.input.operation,
        )
      );
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
      const isProtected = authority.isPendingInputProtected;
      if (!isProtected) {
        throw new Error("Pending input reconciliation requires its live custody owner");
      }
      const window = editPendingWindow(context, command.input.sessionId);
      return createSessionActorMemoryPending(window, context).interruptHistory(command.input, {
        isProtected: (candidate) => isProtected(candidate, context.state.hot.entry?.sessionId),
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
