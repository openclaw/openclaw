/* oxlint-disable eslint/curly -- Keep private prefix guards adjacent to the commit they protect. */
import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptWriteScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  isTranscriptMirrorValidationTokenCurrent,
  readTranscriptMirrorFacts,
} from "./session-accessor.sqlite-transcript-mirror.js";
import { readMessageIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import { appendExpectedSessionTranscriptTurn } from "./session-accessor.sqlite-transcript-turn.js";
import type { CodeModeWaitingClaimIntent } from "./session-accessor.types.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

export type SessionTranscriptPrefixEntry<T = unknown> = {
  codeModeClaimIntent?: CodeModeWaitingClaimIntent;
  codeModeReplay?: { identity: string; message: T };
  eventId: string;
  identity: string;
  message: T;
};
const conflict = (reason: string) => ({ kind: "conflict" as const, reason });

function sourcePayload(message: unknown): unknown {
  const copy = structuredClone(message);
  Reflect.deleteProperty(asOptionalRecord(copy) ?? {}, "timestamp");
  return copy;
}

export async function commitExpectedSessionTranscriptPrefix<T>(
  scope: SessionTranscriptWriteScope,
  options: {
    assertBeforeAppend?: (database: OpenClawAgentDatabase) => void;
    baseAnchor?: TranscriptEntryAnchor;
    entries: readonly SessionTranscriptPrefixEntry<T>[];
    expectedLifecycleRevision?: string;
    expectedWriterRunId?: string;
  },
) {
  const { baseAnchor, entries } = options;
  if (
    entries.some(
      (entry) =>
        entry.codeModeReplay &&
        readMessageIdempotencyKey(entry.codeModeReplay.message) !== entry.codeModeReplay.identity,
    )
  )
    return conflict("identity-mismatch");
  const resolved = resolveSqliteTranscriptScope(scope);
  const facts = readTranscriptMirrorFacts(
    openOpenClawAgentDatabase(toDatabaseOptions(resolved)),
    resolved,
    entries
      .flatMap((entry) => [
        entry.identity,
        ...(entry.codeModeReplay ? [entry.codeModeReplay.identity] : []),
      ])
      .concat(baseAnchor?.idempotencyKey ?? []),
  );
  const resolvedEntries = entries.map((entry) => {
    const replay = entry.codeModeReplay;
    const anchor = replay ? facts.anchorsByIdempotencyKey.get(replay.identity) : undefined;
    const stored = replay ? facts.messagesByIdempotencyKey.get(replay.identity) : undefined;
    const storedMessage = asOptionalRecord(stored);
    const candidate = asOptionalRecord(replay?.message);
    return replay &&
      anchor?.entryId === entry.eventId &&
      storedMessage?.role === "toolResult" &&
      candidate?.role === "toolResult" &&
      storedMessage.toolCallId === candidate.toolCallId &&
      storedMessage.toolName === candidate.toolName &&
      isDeepStrictEqual(sourcePayload(stored), sourcePayload(replay.message))
      ? Object.assign({}, entry, { identity: replay.identity, message: replay.message })
      : entry;
  });
  if (resolvedEntries.some((entry) => readMessageIdempotencyKey(entry.message) !== entry.identity))
    return conflict("identity-mismatch");
  if (new Set(resolvedEntries.map((entry) => entry.identity)).size !== resolvedEntries.length)
    return conflict("duplicate-identity");
  const currentBase = baseAnchor?.idempotencyKey
    ? facts.anchorsByIdempotencyKey.get(baseAnchor.idempotencyKey)
    : undefined;
  if (baseAnchor && (!currentBase || !isDeepStrictEqual(currentBase, baseAnchor)))
    return conflict("base-anchor-mismatch");
  const anchors: TranscriptEntryAnchor[] = [];
  const messages: T[] = [];
  let parentId = baseAnchor?.entryId;
  let position = baseAnchor?.activeMessagePosition;
  for (const entry of resolvedEntries) {
    const anchor = facts.anchorsByIdempotencyKey.get(entry.identity);
    if (!anchor) break;
    const stored = facts.messagesByIdempotencyKey.get(entry.identity);
    if (
      anchor.entryId !== entry.eventId ||
      (parentId !== undefined && anchor.effectiveParentId !== parentId) ||
      (position !== undefined && anchor.activeMessagePosition !== position + 1) ||
      !isDeepStrictEqual(sourcePayload(stored), sourcePayload(entry.message))
    )
      return conflict("prefix-payload-or-topology-mismatch");
    anchors.push(anchor);
    messages.push(stored as T);
    parentId = anchor.entryId;
    position = anchor.activeMessagePosition;
  }
  if (
    resolvedEntries
      .slice(anchors.length)
      .some((entry) => facts.existingIdempotencyKeys.has(entry.identity))
  )
    return conflict("prefix-gap");
  const tail = anchors.at(-1)?.entryId ?? baseAnchor?.entryId ?? facts.activeAppendParentId;
  if (facts.activeAppendParentId !== tail) return conflict("active-branch-drift");
  const prepared = resolvedEntries.slice(anchors.length);
  const turn = await appendExpectedSessionTranscriptTurn(scope, {
    atomicGroup: true,
    expectedLifecycleRevision: options.expectedLifecycleRevision,
    expectedSessionId: scope.sessionId!,
    expectedWriterRunId: options.expectedWriterRunId,
    messages: prepared.map((entry, index) => ({
      ...(entry.codeModeClaimIntent ? { codeModeClaimIntent: entry.codeModeClaimIntent } : {}),
      eventId: entry.eventId,
      idempotencyLookup: "scan" as const,
      message: entry.message,
      parentId: index ? prepared[index - 1]!.eventId : tail,
    })),
    sessionFile: resolved.sessionKey,
    touchSessionEntry: prepared.length > 0,
    validateBeforeAppend: (database) => {
      options.assertBeforeAppend?.(database);
      return isTranscriptMirrorValidationTokenCurrent(database, resolved, facts.validationToken);
    },
  });
  if (turn.rejectedReason === "validation-conflict") return conflict("transaction-drift");
  if (turn.rejectedReason) return { kind: "rejected", reason: "session-rebound" };
  if (!prepared.length) return { anchors, kind: "replayed", messages };
  return {
    anchors: anchors.concat(
      turn.appendedMessages.flatMap((result) => (result.anchor ? [result.anchor] : [])),
    ),
    kind: "committed",
    messages: messages.concat(turn.appendedMessages.map((result) => result.message as T)),
  };
}
