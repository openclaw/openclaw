import { randomUUID } from "node:crypto";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseCompactionDetails } from "../../../packages/agent-core/src/harness/compaction/compaction-details.js";
import { iterateSessionContextEntries } from "../../../packages/agent-core/src/harness/session/session.js";
import { advanceCliHistoryBoundary, getCliHistoryWriter } from "./cli-history-boundary.js";
import type { TranscriptEventAppendOptions } from "./session-accessor.sqlite-contract.js";
import type { SessionActorMemoryState } from "./session-actor-memory-state.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import { normalizeSessionContextEntryBoundaries } from "./session-entry-navigation.js";
import type { SessionMetadataOperations } from "./session-manager-write-contract.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import {
  hasTranscriptMessage,
  shouldProjectActiveEvent,
} from "./session-transcript-projection-append.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import {
  PREPARED_ASSISTANT_MAX_ANCESTORS,
  PREPARED_ASSISTANT_MAX_NEWER_BYTES,
  PREPARED_ASSISTANT_MAX_NEWER_MESSAGES,
  preparedAssistantMessagesPreserveTurn,
  resolveTranscriptAppendParent,
} from "./transcript-append-parent.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import {
  scanSessionTranscriptTree,
  selectSessionTranscriptTreePathNodes,
} from "./transcript-tree.js";

type MetadataInput = SessionMetadataOperations["session.metadata.append"]["input"];

export function createSessionActorMemoryEvents(options: {
  state: SessionActorMemoryState;
  agentId: string;
  path: string;
}) {
  const { state, agentId, path } = options;
  const version = () => ({ ...state.hot.transcript.version });
  const tree = () => scanSessionTranscriptTree(state.events.map(({ event }) => event));
  const requireEntry = () => {
    if (!state.hot.entry) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    return state.hot.entry;
  };
  const refresh = () => {
    const entry = requireEntry();
    const navigation = tree();
    const active = selectSessionTranscriptTreePathNodes(navigation, navigation.leafId);
    let messagePosition = 0;
    const generation = state.hot.transcript.version.generation;
    state.hot.transcript.anchorsState = "resident";
    state.hot.transcript.anchors = active.flatMap((node) => {
      if (
        !hasTranscriptMessage(node.entry) ||
        !shouldProjectActiveEvent(node.entry) ||
        !generation
      ) {
        return [];
      }
      const record = state.events[node.index]!;
      const idempotencyKey = isRecord(node.entry)
        ? readMessageIdempotencyKey(node.entry.message)
        : null;
      return [
        {
          agentId,
          sessionId: entry.sessionId,
          sessionKey: state.hot.target.sessionKey,
          storePath: path,
          generation,
          entryId: node.id,
          rawSeq: record.rawSeq,
          effectiveParentId:
            isRecord(node.entry) && typeof node.entry.parentId === "string"
              ? node.entry.parentId
              : null,
          activeMessagePosition: messagePosition++,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        },
      ];
    });
    const entries = normalizeSessionContextEntryBoundaries(
      active.flatMap((node) =>
        isIndexedSessionEntry(node.entry)
          ? [{ ...node.entry, parentId: node.parentId, seq: state.events[node.index]!.rawSeq }]
          : [],
      ),
      navigation.nodes,
    );
    state.hot.transcript.modelContext = navigation.hasInvalidLeafControl
      ? { kind: "unavailable", reason: "projection", generation }
      : {
          kind: "resident",
          entries: [...iterateSessionContextEntries(entries)].map(({ entry: item }) => ({
            rawSeq: item.seq,
            eventId: item.id,
          })),
        };
  };
  const writeEvent = (
    event: unknown,
    eventJson = JSON.stringify(event),
    lookup?: "scan" | "scan-assistant" | "caller-checked",
  ): boolean => {
    if (
      isRecord(event) &&
      typeof event.id === "string" &&
      state.events.some(({ event: prior }) => isRecord(prior) && prior.id === event.id)
    ) {
      return false;
    }
    const rawSeq = (state.hot.transcript.version.rawSeq ?? -1) + 1;
    const generation = state.hot.transcript.version.generation ?? randomUUID();
    state.events = [...state.events, { rawSeq, event: JSON.parse(eventJson), eventJson }];
    state.hot.transcript.version = {
      generation,
      rawSeq,
      updatedAt: Math.max(Date.now(), (state.hot.transcript.version.updatedAt ?? -1) + 1),
    };
    state.hot.transcript.watermark = { generation, maxSeq: rawSeq };
    const writer = getCliHistoryWriter({
      agentId,
      storePath: path,
      sessionId: requireEntry().sessionId,
      sessionKey: state.hot.target.sessionKey,
    });
    if (writer) {
      const next = advanceCliHistoryBoundary(
        state.hot.entry,
        requireEntry().sessionId,
        generation,
        { first: rawSeq, last: rawSeq },
        writer,
      );
      if (next) {
        writer.assertCurrent();
        state.hot.entry = next;
      }
    }
    if (isRecord(event) && typeof event.id === "string" && event.type === "message") {
      const key = readMessageIdempotencyKey(event.message);
      if (
        key &&
        (lookup !== "scan-assistant" ||
          !state.hot.transcript.idempotency.some((item) => item.key === key))
      ) {
        state.hot.transcript.idempotency = [
          ...state.hot.transcript.idempotency.filter((item) => item.key !== key),
          { key, eventId: event.id, rawSeq },
        ];
      }
    }
    if (
      isRecord(event) &&
      event.type === "compaction" &&
      parseCompactionDetails(event.details)?.qualityDegraded &&
      !requireEntry().compactionQualityDegraded
    ) {
      state.hot.entry = { ...requireEntry(), compactionQualityDegraded: true };
    }
    refresh();
    return true;
  };
  const isAncestor = (leafId: string, candidateId: string | null): boolean => {
    const navigation = tree();
    let current = navigation.byId.get(leafId);
    for (let depth = 0; current && depth < PREPARED_ASSISTANT_MAX_ANCESTORS; depth++) {
      if (current.parentId === candidateId) {
        return true;
      }
      current = current.parentId === null ? undefined : navigation.byId.get(current.parentId);
    }
    return false;
  };
  const parent = (input: { parentId?: string | null; appendIntent?: "active-branch" }) =>
    resolveTranscriptAppendParent({
      ...input,
      tailId: tree().appendParentId,
      parentId: input.parentId,
      isAncestor,
    });
  const checkMutation = (expected: number | null | undefined) => {
    if (expected !== undefined && expected !== state.hot.transcript.version.updatedAt) {
      throw new SqliteTranscriptMutationConflictError(requireEntry().sessionId);
    }
  };
  const rebasePrepared = (input: MetadataInput, parentId: string | null) => {
    const navigation = tree();
    const tail = navigation.appendParentId;
    const admittedUserId = input.view?.admission?.entryId;
    if (
      (tail !== parentId && (tail === null || !isAncestor(tail, parentId))) ||
      (admittedUserId &&
        tail !== admittedUserId &&
        (tail === null || !isAncestor(tail, admittedUserId)))
    ) {
      return false;
    }
    const prepared = parentId === null ? undefined : navigation.byId.get(parentId);
    const admitted = admittedUserId ? navigation.byId.get(admittedUserId) : undefined;
    if ((parentId !== null && !prepared) || (admittedUserId && !admitted)) {
      return false;
    }
    const newer = state.events.filter(
      ({ event }, index) =>
        index > (prepared?.index ?? -1) && isRecord(event) && event.type === "message",
    );
    if (
      newer.length > PREPARED_ASSISTANT_MAX_NEWER_MESSAGES ||
      newer.reduce((sum, row) => sum + Buffer.byteLength(row.eventJson), 0) >
        PREPARED_ASSISTANT_MAX_NEWER_BYTES
    ) {
      return false;
    }
    return preparedAssistantMessagesPreserveTurn(
      newer.flatMap(({ event }) => {
        if (!isRecord(event) || typeof event.id !== "string" || !isRecord(event.message)) {
          return [];
        }
        const message = event.message;
        const internal = asOptionalRecord(message["__openclaw"]);
        const provenance = isRecord(message.provenance) ? message.provenance : undefined;
        return [
          {
            event_id: event.id,
            message_role: message.role,
            context_free_command:
              message.excludeFromContext === true && internal?.contextFreeCommand === true ? 1 : 0,
            provenance_kind: provenance?.kind,
            provenance_source_channel: provenance?.sourceChannel,
          },
        ];
      }),
      admittedUserId,
      () => false,
    );
  };
  const appendRaw = (event: unknown, input: TranscriptEventAppendOptions = {}, bytes?: string) => {
    checkMutation(input.expectedMutationAt);
    const resolved =
      isRecord(event) &&
      (event.parentId === null || typeof event.parentId === "string") &&
      input.appendIntent === "active-branch"
        ? { ...event, parentId: parent({ ...input, parentId: event.parentId }) }
        : event;
    const appended = writeEvent(resolved, resolved === event ? bytes : undefined);
    return appended
      ? {
          appended: true as const,
          ...(isRecord(resolved) &&
          (resolved.parentId === null || typeof resolved.parentId === "string")
            ? { effectiveParentId: resolved.parentId }
            : {}),
        }
      : { appended: false as const };
  };
  const replaceRows = (rows: SessionActorMemoryState["events"]) => {
    const generation = randomUUID();
    const updatedAt = Math.max(Date.now(), (state.hot.transcript.version.updatedAt ?? -1) + 1);
    state.events = rows;
    state.hot.transcript.version = { generation, rawSeq: rows.at(-1)?.rawSeq ?? null, updatedAt };
    state.hot.transcript.watermark = { generation, maxSeq: rows.at(-1)?.rawSeq ?? null };
    const identities = new Map<string, { key: string; eventId: string; rawSeq: number }>();
    for (const row of rows) {
      if (
        !isRecord(row.event) ||
        row.event.type !== "message" ||
        typeof row.event.id !== "string"
      ) {
        continue;
      }
      const key = readMessageIdempotencyKey(row.event.message);
      if (key) {
        identities.set(key, { key, eventId: row.event.id, rawSeq: row.rawSeq });
      }
    }
    state.hot.transcript.idempotency = [...identities.values()];
    refresh();
  };
  return {
    version,
    tree,
    writeEvent,
    parent,
    checkMutation,
    rebasePrepared,
    appendRaw,
    replaceRows,
  };
}
