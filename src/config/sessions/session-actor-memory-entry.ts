import { isDeepStrictEqual } from "node:util";
import { clearSessionActorProgressCardForReset } from "../../session-cards/session-actor-progress-card-memory.js";
import type { ConversationRouteContext } from "./conversation-route-context.js";
import { syncSessionActorMemoryConversations } from "./session-actor-memory-conversation.js";
import type {
  SessionActorMemoryEntryCommand,
  SessionActorMemoryEntryQuery,
  SessionActorMemoryMaintenance,
  SessionActorMemoryEntryWrites,
} from "./session-actor-memory-entry-contract.js";
import { validateSessionActorMemoryEntryGuards } from "./session-actor-memory-entry-guards.js";
import { installSessionActorMemoryEntry } from "./session-actor-memory-entry-install.js";
import { createSessionActorMemoryEvents } from "./session-actor-memory-events.js";
import { planMemoryLifecycleArtifacts } from "./session-actor-memory-lifecycle-artifacts.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import { projectSessionEntryPatch } from "./session-entry-patch-operation.js";
import {
  attachSessionEntrySnapshots,
  type SessionEntryProjection,
} from "./session-entry-snapshot-values.js";
import { SqliteSessionMutationConflictError } from "./session-mutation-conflict-error.js";
import { buildSessionResetBoundaryEvent } from "./session-reset-boundary-event.js";
import { planSessionEntryMaintenance } from "./store-maintenance-plan.js";
import { resolveSessionMaintenancePreserveKeys } from "./store-maintenance-preserve-snapshot.js";
import { countUnarchivedSessionEntries } from "./store-maintenance.js";
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
    case "session.lifecycle.artifacts":
      return planMemoryLifecycleArtifacts(context, query.input);
    case "session.entry.creation":
      return {
        existingEntry: context.state.hot.entry,
        targetEntry: context.state.hot.entry,
        labelInUse: Boolean(
          query.input.label &&
          [...context.entries()].some(
            ([key, state]) =>
              key !== context.state.hot.target.sessionKey &&
              state.hot.entry?.label === query.input.label,
          ),
        ),
      };
    case "session.entry.read": {
      const entry = query.input.sessionKey
        ? context.get(query.input.sessionKey)?.hot.entry
        : context.state.hot.entry;
      return entry && projectEntry(entry, query.input.projection);
    }
    case "session.entry.readById":
      for (const [sessionKey, state] of context.entries()) {
        const entry =
          state.hot.entry?.sessionId === query.input.sessionId
            ? state.hot.entry
            : query.input.currentOnly
              ? undefined
              : state.historicalWindows.get(query.input.sessionId)?.hot.entry;
        if (entry) {
          context.get(sessionKey);
          return { sessionKey, entry: projectEntry(entry, query.input.projection) };
        }
      }
      return undefined;
    case "session.entries.read": {
      const selected = query.input.sessionKeys && new Set(query.input.sessionKeys);
      return [...context.entries()].flatMap(([sessionKey, state]) => {
        if (!state.hot.entry) {
          return [];
        }
        if (
          selected &&
          !selected.has(sessionKey) &&
          !(
            query.input.includeSessionWindowOwner &&
            (state.hot.entry.sessionId === query.input.includeSessionWindowOwner ||
              state.historicalWindows.has(query.input.includeSessionWindowOwner))
          ) &&
          !(
            query.input.includeLabelOwners &&
            state.hot.entry.label === query.input.includeLabelOwners
          )
        ) {
          return [];
        }
        context.get(sessionKey);
        return [{ sessionKey, entry: projectEntry(state.hot.entry, query.input.projection) }];
      });
    }
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
  const install = (
    key: string,
    entry: SessionEntry,
    options?: Parameters<typeof installSessionActorMemoryEntry>[2] & {
      routeContext?: ConversationRouteContext | null;
    },
  ) => {
    const target = context.edit(key);
    const previous = target.hot.entry;
    const installed = installSessionActorMemoryEntry(target, entry, options);
    if (options?.routeContext !== undefined) {
      syncSessionActorMemoryConversations(
        target,
        context.editConversations(),
        previous,
        options.routeContext,
      );
    }
    return installed;
  };
  const maintain = (
    maintenance: SessionActorMemoryMaintenance | undefined,
    activeSessionKey?: string,
  ) => {
    if (maintenance && maintenance.config.mode !== "warn") {
      const store: Record<string, SessionEntry> = {};
      for (const [key, current] of context.entries()) {
        if (current.hot.entry) {
          store[key] = { ...current.hot.entry };
        }
      }
      planSessionEntryMaintenance({
        maintenance: maintenance.config,
        initialUnarchivedCount: countUnarchivedSessionEntries(store),
        readPreserveKeys: () =>
          resolveSessionMaintenancePreserveKeys({
            store,
            snapshot: maintenance.preservation,
            baseKeys: [activeSessionKey],
          }),
        readAgeCandidates: () => store,
        readCapCandidates: () => ({ store, maxEntries: maintenance.config.maxEntries }),
        onArchived: ({ key, entry: archived }) => {
          install(key, archived);
        },
        onRemoved: ({ key }) => context.remove(key),
      });
    }
  };
  const replace = (
    replacement: SessionActorMemoryEntryWrites["session.entry.replacements"]["input"]["replacements"][number],
    consumePendingReset?: boolean,
  ) => {
    requireExpectedEntry(
      context.get(replacement.sessionKey)?.hot.entry,
      replacement.expected,
      command.type,
    );
    if (!replacement.entry) {
      context.remove(replacement.sessionKey);
      return undefined;
    }
    const entry = install(
      replacement.sessionKey,
      {
        ...replacement.entry,
        ...(replacement.label === undefined ? {} : { label: replacement.label }),
        ...(replacement.owner ? { owner: replacement.owner } : {}),
      },
      { routeContext: replacement.routeContext, consumePendingReset },
    );
    if (replacement.transcriptEvents) {
      const target = context.edit(replacement.sessionKey);
      const events = createSessionActorMemoryEvents({ ...context, state: target });
      for (const event of replacement.transcriptEvents) {
        events.writeEvent(event);
      }
    }
    if (
      replacement.label &&
      [...context.entries()].some(
        ([key, value]) =>
          key !== replacement.sessionKey && value.hot.entry?.label === replacement.label,
      )
    ) {
      throw new Error(`Session label already exists: ${replacement.label}`);
    }
    return entry;
  };
  switch (command.type) {
    case "session.entry.create": {
      const input = command.input;
      requireExpectedEntry(state.hot.entry, input.expected, command.type);
      const label = input.label ?? input.entry.label;
      if (
        label &&
        [...context.entries()].some(
          ([key, value]) => key !== sessionKey && value.hot.entry?.label === label,
        )
      ) {
        const error = new Error(`label already in use: ${label}`);
        error.name = "SessionLabelConflictError";
        throw error;
      }
      install(
        sessionKey,
        {
          ...input.entry,
          ...(label !== undefined ? { label } : {}),
          ...(input.owner ? { owner: input.owner } : {}),
        },
        { routeContext: input.routeContext },
      );
      const events = createSessionActorMemoryEvents(context);
      for (const event of input.transcriptEvents ??
        (state.events.length
          ? []
          : [
              createSessionTranscriptHeader({ sessionId: input.entry.sessionId, cwd: input.cwd }),
            ])) {
        events.writeEvent(event);
      }
      return state.hot.entry!;
    }
    case "session.entry.patch": {
      if (command.input.prepareIf && !state.hot.entry?.liveModelSwitchPending) {
        return undefined;
      }
      if (command.input.expected) {
        requireExpectedEntry(state.hot.entry, command.input.expected.entry, command.type);
      }
      if (!validateSessionActorMemoryEntryGuards(context, command.input.guards)) {
        return undefined;
      }
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
        replaceEntry: command.input.replaceEntry,
      });
      const entry = next ? install(sessionKey, next, command.input) : state.hot.entry;
      maintain(command.input.maintenance, sessionKey);
      return entry;
    }
    case "session.entry.replace": {
      return replace({ ...command.input, sessionKey });
    }
    case "session.entry.replacements": {
      const removedSessionKeys: string[] = [];
      const updatedSessionKeys: string[] = [];
      for (const replacement of command.input.replacements) {
        replace(replacement, command.input.consumePendingReset);
        if (replacement.entry) {
          updatedSessionKeys.push(replacement.sessionKey);
        } else {
          removedSessionKeys.push(replacement.sessionKey);
        }
      }
      maintain(command.input.maintenance, command.input.maintenance?.activeSessionKey);
      return { removedSessionKeys, updatedSessionKeys };
    }
    case "session.lifecycle.reset": {
      const previousEntry = state.hot.entry;
      const input = command.input;
      requireExpectedEntry(previousEntry, input.expected, command.type);
      const writeBoundary = Boolean(
        input.resetBoundary && previousEntry && !isDeepStrictEqual(previousEntry, input.nextEntry),
      );
      if (writeBoundary && input.resetBoundary && previousEntry) {
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
      const progressCardReset =
        writeBoundary &&
        input.resetBoundary?.context === "clear" &&
        clearSessionActorProgressCardForReset(state);
      const nextEntry = install(sessionKey, input.nextEntry, {
        consumePendingReset: true,
        routeContext: input.routeContext,
      });
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
      const eligible =
        command.input.artifacts &&
        planMemoryLifecycleArtifacts(
          context,
          command.input.artifacts.input,
          new Map(
            command.input.entries.map((candidate) => [candidate.sessionKey, candidate.expected]),
          ),
        );
      for (const candidate of command.input.entries) {
        if (
          eligible
            ? eligible.entries.some((entry) => entry.sessionKey === candidate.sessionKey)
            : isDeepStrictEqual(context.get(candidate.sessionKey)?.hot.entry, candidate.expected)
        ) {
          context.remove(candidate.sessionKey);
          removedSessionKeys.push(candidate.sessionKey);
        }
      }
      for (const window of command.input.artifacts?.windows ?? []) {
        if (
          eligible?.windows.some(
            (candidate) =>
              candidate.sessionKey === window.sessionKey &&
              candidate.sessionId === window.sessionId,
          )
        ) {
          context.edit(window.sessionKey).historicalWindows.delete(window.sessionId);
        }
      }
      return { removedSessionKeys };
    }
  }
  throw new Error("Unknown memory entry command");
}
