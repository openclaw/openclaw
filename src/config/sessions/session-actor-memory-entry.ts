import { isDeepStrictEqual } from "node:util";
import type {
  SessionActorMemoryEntryCommand,
  SessionActorMemoryEntryQuery,
} from "./session-actor-memory-entry-contract.js";
import { installSessionActorMemoryEntry } from "./session-actor-memory-entry-install.js";
import { createSessionActorMemoryEvents } from "./session-actor-memory-events.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import { projectSessionEntryPatch } from "./session-entry-patch-operation.js";
import {
  attachSessionEntrySnapshots,
  type SessionEntryProjection,
} from "./session-entry-snapshot-values.js";
import { SqliteSessionMutationConflictError } from "./session-mutation-conflict-error.js";
import { buildSessionResetBoundaryEvent } from "./session-reset-boundary-event.js";
import {
  createSessionTranscriptHeader,
  resolveResetBoundaryHeaderCwd,
} from "./transcript-header.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

function projectEntry(entry: SessionEntry, projection?: SessionEntryProjection): SessionEntry {
  // Strip large optional snapshots before the owner detaches a list result.
  return attachSessionEntrySnapshots({ ...entry }, {}, projection);
}

export function readSessionActorMemoryEntryQuery(
  context: SessionActorMemoryStorageContext,
  query: SessionActorMemoryEntryQuery,
) {
  switch (query.type) {
    case "session.entry.read":
      return (
        context.state.hot.entry && projectEntry(context.state.hot.entry, query.input.projection)
      );
    case "session.entry.readById":
      for (const [sessionKey, state] of context.entries()) {
        const entry =
          state.hot.entry?.sessionId === query.input.sessionId
            ? state.hot.entry
            : state.historicalWindows.get(query.input.sessionId)?.hot.entry;
        if (entry) {
          context.get(sessionKey);
          return { sessionKey, entry: projectEntry(entry, query.input.projection) };
        }
      }
      return undefined;
    case "session.entries.read":
      return [...context.entries()].flatMap(([sessionKey, state]) => {
        if (!state.hot.entry) {
          return [];
        }
        context.get(sessionKey);
        return [{ sessionKey, entry: projectEntry(state.hot.entry, query.input.projection) }];
      });
  }
  throw new Error("Unknown memory entry query");
}

function requireExpectedEntry(
  actual: SessionEntry | undefined,
  expected: SessionEntry | undefined,
  operation: string,
): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new SqliteSessionMutationConflictError(operation);
  }
}

export function executeSessionActorMemoryEntryCommand(
  context: SessionActorMemoryStorageContext,
  command: SessionActorMemoryEntryCommand,
) {
  const { state } = context;
  const sessionKey = state.hot.target.sessionKey;
  const install = (key: string, entry: SessionEntry) => {
    const target = context.edit(key);
    return installSessionActorMemoryEntry(target, entry);
  };
  switch (command.type) {
    case "session.entry.create": {
      const input = command.input;
      requireExpectedEntry(state.hot.entry, undefined, command.type);
      const label = input.label ?? input.entry.label;
      if (
        label &&
        [...context.entries()].some(
          ([key, value]) => key !== sessionKey && value.hot.entry?.label === label,
        )
      ) {
        const error = new Error(`Session label already exists: ${label}`);
        error.name = "SessionLabelConflictError";
        throw error;
      }
      install(sessionKey, {
        ...input.entry,
        ...(label !== undefined ? { label } : {}),
        ...(input.owner ? { owner: input.owner } : {}),
      });
      const events = createSessionActorMemoryEvents(context);
      for (const event of input.transcriptEvents ?? [
        createSessionTranscriptHeader({ sessionId: input.entry.sessionId, cwd: input.cwd }),
      ]) {
        events.writeEvent(event);
      }
      return state.hot.entry!;
    }
    case "session.entry.patch": {
      const writeBase = state.hot.entry ?? command.input.fallbackEntry;
      if (!writeBase) {
        return undefined;
      }
      const next = projectSessionEntryPatch({
        existing: state.hot.entry,
        writeBase,
        sessionKey,
        operation: command.input.operation,
        preserveActivity: command.input.preserveActivity,
      });
      return next ? install(sessionKey, next) : state.hot.entry;
    }
    case "session.entry.replace": {
      requireExpectedEntry(state.hot.entry, command.input.expected, command.type);
      if (!command.input.entry) {
        context.remove(sessionKey);
        return undefined;
      }
      return install(sessionKey, command.input.entry);
    }
    case "session.entry.replacements": {
      const removedSessionKeys: string[] = [];
      const updatedSessionKeys: string[] = [];
      for (const replacement of command.input.replacements) {
        const current = context.get(replacement.sessionKey);
        requireExpectedEntry(current?.hot.entry, replacement.expected, command.type);
        if (replacement.entry) {
          install(replacement.sessionKey, replacement.entry);
          updatedSessionKeys.push(replacement.sessionKey);
        } else {
          context.remove(replacement.sessionKey);
          removedSessionKeys.push(replacement.sessionKey);
        }
      }
      return { removedSessionKeys, updatedSessionKeys };
    }
    case "session.lifecycle.reset": {
      const previousEntry = state.hot.entry;
      const input = command.input;
      requireExpectedEntry(previousEntry, input.expected, command.type);
      const progressCardReset = Boolean(
        input.resetBoundary && previousEntry && !isDeepStrictEqual(previousEntry, input.nextEntry),
      );
      if (progressCardReset && input.resetBoundary && previousEntry) {
        const events = createSessionActorMemoryEvents(context);
        if (!state.events.length) {
          events.writeEvent(
            createSessionTranscriptHeader({
              sessionId: previousEntry.sessionId,
              cwd: resolveResetBoundaryHeaderCwd(previousEntry, input.resetBoundary.cwd),
            }),
          );
        }
        events.writeEvent(
          buildSessionResetBoundaryEvent({
            ...input.resetBoundary,
            events: state.events.map(({ event }) => event),
          }),
        );
      }
      const nextEntry = install(sessionKey, input.nextEntry);
      return {
        archivedTranscripts: [],
        previousEntry,
        previousSessionId: previousEntry?.sessionId,
        nextEntry,
        progressCardReset,
      };
    }
    case "session.lifecycle.delete": {
      const entry = state.hot.entry;
      const input = command.input;
      if (
        (input.expectedEntry !== undefined && !isDeepStrictEqual(entry, input.expectedEntry)) ||
        (input.expectedSessionId !== undefined &&
          (entry?.sessionId ?? null) !== input.expectedSessionId) ||
        (input.expectedLifecycleRevision !== undefined &&
          entry?.lifecycleRevision !== input.expectedLifecycleRevision) ||
        (input.expectedUpdatedAt !== undefined && entry?.updatedAt !== input.expectedUpdatedAt)
      ) {
        return { archivedTranscripts: [], deleted: false, expectedEntryMismatch: true as const };
      }
      context.remove(sessionKey);
      return {
        archivedTranscripts: [],
        deleted: Boolean(entry),
        deletedEntry: entry,
        deletedSessionId: entry?.sessionId,
      };
    }
    case "session.lifecycle.reclaim": {
      const removedSessionKeys: string[] = [];
      for (const candidate of command.input.entries) {
        if (isDeepStrictEqual(context.get(candidate.sessionKey)?.hot.entry, candidate.expected)) {
          context.remove(candidate.sessionKey);
          removedSessionKeys.push(candidate.sessionKey);
        }
      }
      return { removedSessionKeys };
    }
  }
  throw new Error("Unknown memory entry command");
}
