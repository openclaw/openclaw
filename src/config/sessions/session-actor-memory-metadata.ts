import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { installSessionActorMemoryEntry } from "./session-actor-memory-entry-install.js";
import { createSessionActorMemoryEvents } from "./session-actor-memory-events.js";
import { initializeSessionActorMemoryEntry } from "./session-actor-memory-initialize.js";
import { createSessionActorMemoryMessages } from "./session-actor-memory-messages.js";
import type { SessionActorMemoryMetadataCommand } from "./session-actor-memory-metadata-contract.js";
import { resolveSessionActorMemoryWindow } from "./session-actor-memory-state.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import { createSessionActorMemoryTranscript } from "./session-actor-memory-transcript.js";
import { isReadableSessionMessage } from "./session-entry-codec.js";
import { projectCompactionAccountingPatch } from "./session-entry-projection.js";
import type { SessionMetadataOperations } from "./session-manager-write-contract.js";
import { sessionMatchesExpectedTranscriptTurn } from "./session-transcript-turn-state.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import { canonicalizeTranscriptEventMedia } from "./transcript-event-media.js";

type Scope = SessionMetadataOperations["session.metadata.append"]["input"]["scope"];

/** Metadata participates in the actor's working copy and commits with its other domains. */
export function createSessionActorMemoryMetadata(context: SessionActorMemoryStorageContext) {
  const { state, agentId, path } = context;
  const events = createSessionActorMemoryEvents(context);
  const transcript = createSessionActorMemoryTranscript(context);
  const assertTarget = (scope: Scope) => {
    if (
      (scope.agentId !== undefined && scope.agentId !== agentId) ||
      (scope.storePath !== undefined && scope.storePath !== path) ||
      (scope.sessionKey !== undefined && scope.sessionKey !== state.hot.target.sessionKey)
    ) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
  };
  const scopeIsCurrent = (scope: Scope) =>
    sessionMatchesExpectedTranscriptTurn(state.hot.entry ? { entry: state.hot.entry } : undefined, {
      ...scope,
      expectedSessionId: scope.sessionId,
    });
  const assertScope = (scope: Scope) => {
    if (!scopeIsCurrent(scope)) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
  };
  const replaceSuffix = (
    input: SessionMetadataOperations["session.transcript.replaceSuffix"]["input"],
  ) => {
    if (!scopeIsCurrent(input.scope)) {
      if (input.scope.expectedWriterRunId !== undefined) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
      return { replaced: false, projectionNeedsReconcile: false };
    }
    const [
      expectedEvents,
      nextEvents,
      prefixLength,
      expectedMutationAt,
      startsAtPrefix,
      retainedIds,
    ] = input.args;
    const incremental = prefixLength > 0 || startsAtPrefix;
    const expected = (startsAtPrefix ? expectedEvents : expectedEvents.slice(prefixLength)).map(
      canonicalizeTranscriptEventMedia,
    );
    const next = (startsAtPrefix ? nextEvents : nextEvents.slice(prefixLength)).map(
      canonicalizeTranscriptEventMedia,
    );
    const stored = incremental
      ? state.events.filter((row) => row.rawSeq >= prefixLength)
      : state.events;
    const retained = new Set(retainedIds);
    const projectRetained = (event: unknown) => {
      if (
        isRecord(event) &&
        event.type === "custom" &&
        typeof event.id === "string" &&
        retained.has(event.id)
      ) {
        const { data: _data, ...rest } = event;
        return rest;
      }
      return event;
    };
    if (
      (expectedMutationAt !== undefined && expectedMutationAt !== events.version().updatedAt) ||
      stored.length !== expected.length ||
      stored.some((row, index) => !isDeepStrictEqual(projectRetained(row.event), expected[index]))
    ) {
      throw new Error(
        `SQLite transcript changed while preparing suffix removal for ${input.scope.sessionId}`,
      );
    }
    let common = 0;
    while (
      common < expected.length &&
      common < next.length &&
      isDeepStrictEqual(expected[common], next[common])
    ) {
      common++;
    }
    const unchanged = common === expected.length && common === next.length;
    if (next.length > expected.length || (!incremental && !unchanged && common === 0)) {
      throw new Error(
        `Transcript mutation is not a bounded suffix removal for ${input.scope.sessionId}`,
      );
    }
    if (incremental && unchanged) {
      return { replaced: true, version: events.version(), projectionNeedsReconcile: false };
    }
    const originals = new Map(
      stored.flatMap((row) =>
        isRecord(row.event) && typeof row.event.id === "string"
          ? [[row.event.id, row] as const]
          : [],
      ),
    );
    const preserved = state.events.slice(0, state.events.length - stored.length + common);
    const startSeq = stored[common]?.rawSeq ?? (stored.at(-1)?.rawSeq ?? prefixLength - 1) + 1;
    const replacements = next.slice(common).map((event, index) => {
      const original =
        isRecord(event) && typeof event.id === "string" ? originals.get(event.id) : undefined;
      let nextEvent = event;
      if (
        isRecord(event) &&
        event.type === "custom" &&
        typeof event.id === "string" &&
        retained.has(event.id)
      ) {
        if (!original || !isRecord(original.event)) {
          throw new Error("Retained transcript data has no original suffix row");
        }
        const projected = projectRetained(original.event);
        if (!isRecord(projected)) {
          throw new Error("Retained transcript data has no original suffix row");
        }
        const { parentId: _oldParent, ...before } = projected;
        const { parentId, ...after } = event;
        if (
          Object.hasOwn(after, "data") ||
          !isDeepStrictEqual(before, after) ||
          (parentId !== null && typeof parentId !== "string")
        ) {
          throw new Error("Retained transcript data permits only parent repair");
        }
        nextEvent = { ...original.event, parentId };
      }
      const eventJson =
        original && isDeepStrictEqual(original.event, nextEvent)
          ? original.eventJson
          : JSON.stringify(nextEvent);
      return { rawSeq: startSeq + index, event: JSON.parse(eventJson), eventJson };
    });
    events.replaceRows([...preserved, ...replacements]);
    return { replaced: true, version: events.version(), projectionNeedsReconcile: false };
  };
  function execute<Command extends SessionActorMemoryMetadataCommand>(
    command: Command,
  ): SessionMetadataOperations[Command["type"]]["output"];
  function execute(
    command: SessionActorMemoryMetadataCommand,
  ): SessionMetadataOperations[keyof SessionMetadataOperations]["output"] {
    const { scope } = command.input;
    assertTarget(scope);
    switch (command.type) {
      case "session.metadata.mutation":
        return (
          resolveSessionActorMemoryWindow(state, scope.sessionId)?.hot.transcript.version
            .updatedAt ?? null
        );
      case "session.metadata.initialize":
        return initializeSessionActorMemoryEntry(context, command.input);
      case "session.metadata.append": {
        const result = transcript.append({ kind: "metadata", input: command.input });
        if (result.kind !== "metadata") {
          throw new Error("Metadata append returned another operation");
        }
        return result.value;
      }
      case "session.transcript.appendMessage": {
        const result = transcript.append({ kind: "message", input: command.input });
        if (result.kind !== "message") {
          throw new Error("Message append returned another operation");
        }
        return result.value;
      }
      case "session.transcript.branch": {
        assertScope(scope);
        const previous = state.hot.entry!;
        if (previous.lifecycleRevision !== command.input.expectedLifecycleRevision) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
        const next = {
          ...previous,
          sessionId: command.input.branch.sessionId,
          updatedAt: Date.now(),
        };
        const installed = installSessionActorMemoryEntry(state, next);
        const rows = command.input.branch.events.map((event, rawSeq) => {
          const eventJson = JSON.stringify(canonicalizeTranscriptEventMedia(event));
          return { rawSeq, event: JSON.parse(eventJson), eventJson };
        });
        events.replaceRows(rows);
        return {
          identity: {
            previous: new Map([[state.hot.target.sessionKey, structuredClone(previous)]]),
            current: new Map([[state.hot.target.sessionKey, structuredClone(installed)]]),
          },
          version: events.version(),
          projectionNeedsReconcile: false,
        };
      }
      case "session.transcript.replaceSuffix":
        return replaceSuffix(command.input);
      case "session.transcript.rewrite": {
        assertScope(scope);
        const { version, appendParentId, sources, pendingInput } = command.input;
        const current = events.version();
        if (
          current.generation !== version.generation ||
          current.rawSeq !== version.rawSeq ||
          events.tree().appendParentId !== appendParentId
        ) {
          throw new Error("Session transcript changed before rewrite publication");
        }
        const original = new Map(sources);
        for (const source of original.values()) {
          const row = state.events.find(({ event }) => isRecord(event) && event.id === source.id);
          if (!row || !isDeepStrictEqual(row.event, source)) {
            throw new Error("Session transcript changed before rewrite publication");
          }
        }
        const entries = structuredClone(command.input.entries);
        const messages = createSessionActorMemoryMessages(context, events);
        let pendingInputReceipt;
        for (const entry of entries) {
          if (entry.type === "message") {
            const source = original.get(entry.id);
            if (!source) {
              throw new Error("Transcript rewrite message has no source entry");
            }
            const appended = messages.appendMessage({
              eventId: entry.id,
              parentId: entry.parentId,
              now: Date.parse(entry.timestamp),
              message: entry.message,
              appendMode: entry.appendMode,
              idempotencyLookup: "caller-checked",
              custody: pendingInput ? { ...pendingInput, relocation: source.id } : undefined,
            });
            if (!appended.result?.appended || appended.result.messageId !== entry.id) {
              throw new Error("Transcript rewrite message was not appended");
            }
            if (!isReadableSessionMessage(appended.result.message)) {
              throw new Error("Transcript rewrite produced an invalid message");
            }
            entry.message = appended.result.message;
            pendingInputReceipt = appended.receipt ?? pendingInputReceipt;
          } else if (!events.appendRaw(entry).appended) {
            throw new Error("Transcript rewrite entry was not appended");
          }
        }
        return {
          version: events.version(),
          entries,
          pendingInputReceipt,
          projectionNeedsReconcile: false,
        };
      }
      case "session.transcript.compactionBoundary": {
        const { prepared } = command.input;
        assertTarget(prepared.scope);
        if (prepared.scope.sessionId !== scope.sessionId) {
          throw new SessionTranscriptWriterClaimReboundError();
        }
        let initialEntry;
        if (prepared.initializeEntry) {
          initialEntry = initializeSessionActorMemoryEntry(context, {
            scope: prepared.scope,
            entry: { sessionId: scope.sessionId, updatedAt: Date.now() },
            initialWriterRunId: command.input.initialWriterRunId,
          });
          if (!initialEntry.owned) {
            throw new Error("Session transcript header was not persisted");
          }
        }
        assertScope({ ...scope, ...initialEntry?.fence });
        assertScope({ ...prepared.scope, ...initialEntry?.fence });
        if (prepared.event.type !== "compaction") {
          throw new Error("Compaction boundary validation failed");
        }
        const event = {
          ...prepared.event,
          parentId: events.parent({
            parentId: prepared.event.parentId,
            appendIntent: prepared.appendIntent,
          }),
        };
        const before = events.version();
        if (
          !events.appendRaw(event, { expectedMutationAt: prepared.expectedMutationAt }).appended
        ) {
          throw new Error(`Session transcript entry was not persisted: ${event.id}`);
        }
        state.hot.entry = {
          ...state.hot.entry!,
          ...projectCompactionAccountingPatch(state.hot.entry!, {
            compactionKind: "context-engine",
            transcriptByteCompactionLatch: command.input.transcriptByteCompactionLatch,
          }),
        };
        return {
          committed: { result: event, before, after: events.version() },
          initialEntry,
          projectionNeedsReconcile: false,
        };
      }
    }
    throw new Error("Unknown memory metadata operation");
  }
  return { execute };
}
