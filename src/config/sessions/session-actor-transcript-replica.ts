import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import {
  readSessionActorBoundedHistory,
  type SessionActorTranscriptRow,
} from "./session-actor-bounded-history.js";
import type { SessionActorHotState, SessionActorOutcome } from "./session-actor-contract.js";
import type { PreparedSessionTranscriptHydration } from "./session-history-read.types.js";
import type { SessionTranscriptAuthority } from "./session-transcript-authority.types.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";

type Bounded = Extract<PreparedSessionTranscriptHydration, { kind: "bounded" }>;
type Limits = { maxBytes: number; maxEvents: number };

/** A projection owned and evicted by ReplicaCell, never a separate transcript authority. */
export type SessionActorTranscriptReplica = {
  version: SessionTranscriptContextVersion;
  sessionId: string | undefined;
  tail: { events: SessionActorTranscriptRow[]; coveredAfterSeq: number };
  context?: {
    limits: Limits;
  } & (
    | {
        rows: SessionActorTranscriptRow[];
        activeLeafEntryId: string | null;
        exact?: never;
        admission?: never;
      }
    | { rows?: never; exact: Bounded; admission?: UserTurnTranscriptAdmissionReceipt }
  );
};

export function sameSessionActorTranscriptVersion(
  left: SessionTranscriptContextVersion,
  right: SessionTranscriptContextVersion,
): boolean {
  return (
    left.generation === right.generation &&
    left.rawSeq === right.rawSeq &&
    left.updatedAt === right.updatedAt
  );
}

function simplePath(rows: SessionActorTranscriptRow[]) {
  let parent: string | null = null;
  for (const { event } of rows) {
    if (!isRecord(event)) {
      return undefined;
    }
    if (event.type === "session") {
      continue;
    }
    // Controls can change ancestry, retention or display policy. The canonical reader owns them.
    if (
      !["message", "model_change", "thinking_level_change"].includes(String(event.type)) ||
      event.appendMode === "side" ||
      typeof event.id !== "string" ||
      event.parentId !== parent ||
      (isRecord(event.message) && event.message.excludeFromContext === true)
    ) {
      return undefined;
    }
    parent = event.id;
  }
  return { activeLeafEntryId: parent };
}

function fits(rows: SessionActorTranscriptRow[], limits: Limits): boolean {
  return (
    rows.filter((row) => !isRecord(row.event) || row.event.type !== "session").length <=
      limits.maxEvents &&
    rows.reduce((bytes, row) => bytes + row.serializedBytes, 0) <= limits.maxBytes
  );
}

function boundedTail(events: SessionActorTranscriptRow[], coveredAfterSeq: number) {
  // A reply only needs the recent suffix. Large/old tails fall back to the bounded history owner.
  let bytes = events.reduce((sum, row) => sum + row.serializedBytes, 0);
  let afterSeq = coveredAfterSeq;
  while (events.length > 128 || bytes > 512 * 1024) {
    const removed = events.shift()!;
    bytes -= removed.serializedBytes;
    afterSeq = removed.rawSeq;
  }
  return { events, coveredAfterSeq: afterSeq };
}

export function rewriteSessionActorTranscriptReplica(
  previous: SessionActorTranscriptReplica | undefined,
  rewrite: NonNullable<SessionTranscriptAuthority["actorRewrite"]>,
): SessionActorTranscriptReplica | undefined {
  const { postimage } = rewrite;
  if (
    !previous ||
    previous.sessionId !== postimage.entry?.sessionId ||
    !sameSessionActorTranscriptVersion(previous.version, rewrite.before)
  ) {
    return undefined;
  }
  const rewritten = new Map(rewrite.rows.map((row) => [row.rawSeq, row]));
  const patch = (rows: SessionActorTranscriptRow[]) =>
    rows.map((row) => rewritten.get(row.rawSeq) ?? row);
  const next: SessionActorTranscriptReplica = {
    version: postimage.transcript.version,
    sessionId: previous.sessionId,
    tail: boundedTail(patch(previous.tail.events), previous.tail.coveredAfterSeq),
  };
  if (previous.context?.rows) {
    const rows = patch(previous.context.rows);
    const path = simplePath(rows);
    if (path && fits(rows, previous.context.limits)) {
      next.context = {
        ...previous.context,
        rows,
        ...path,
      };
    }
  }
  return next;
}

export function seedSessionActorTranscriptContext(
  retained: SessionActorTranscriptReplica | undefined,
  hot: SessionActorHotState,
  prepared: Bounded,
  limits: Limits,
  admission?: UserTurnTranscriptAdmissionReceipt,
): SessionActorTranscriptReplica | undefined {
  if (!sameSessionActorTranscriptVersion(hot.transcript.version, prepared.snapshot.version)) {
    return retained;
  }
  const current: SessionActorTranscriptReplica =
    retained && sameSessionActorTranscriptVersion(retained.version, hot.transcript.version)
      ? retained
      : {
          version: hot.transcript.version,
          sessionId: hot.entry?.sessionId,
          tail: { events: [], coveredAfterSeq: hot.transcript.version.rawSeq ?? -1 },
        };
  if (!prepared.residentRows && current.context) {
    return current;
  }
  const rows = prepared.residentRows?.map((row, index) => ({
    ...row,
    event: structuredClone(prepared.snapshot.events[index]),
  }));
  let complete: SessionActorTranscriptRow[] | undefined;
  if (rows && !prepared.snapshot.truncated && prepared.snapshot.boundaryCount === 0) {
    const known = new Map(rows.map((row) => [row.rawSeq, row]));
    for (const row of current.tail.events) {
      if (row.rawSeq > (rows.at(-1)?.rawSeq ?? -1)) {
        known.set(row.rawSeq, row);
      }
    }
    const candidates = [...known.values()].toSorted((a, b) => a.rawSeq - b.rawSeq);
    const context = hot.transcript.modelContext;
    if (
      context.kind === "resident" &&
      context.entries.every((row) => known.has(row.rawSeq)) &&
      candidates.filter((row) => isRecord(row.event) && row.event.type !== "session").length ===
        prepared.snapshot.totalEvents &&
      simplePath(candidates) &&
      fits(candidates, limits)
    ) {
      complete = candidates;
    }
  }
  return {
    ...current,
    context: complete
      ? {
          limits: { ...limits },
          rows: complete,
          activeLeafEntryId: prepared.snapshot.activeLeafEntryId,
        }
      : {
          limits: { ...limits },
          exact: structuredClone(prepared),
          admission: admission && { ...admission },
        },
  };
}

export function advanceSessionActorTranscriptReplica(
  previous: SessionActorTranscriptReplica | undefined,
  outcome: Extract<SessionActorOutcome<unknown>, { kind: "committed" }>,
): SessionActorTranscriptReplica {
  const { transcript, postimage } = outcome.receipt;
  const unchanged = sameSessionActorTranscriptVersion(transcript.before, transcript.after);
  const retained =
    previous &&
    previous.sessionId === postimage.entry?.sessionId &&
    sameSessionActorTranscriptVersion(previous.version, transcript.before)
      ? previous
      : undefined;
  if (unchanged && retained) {
    return retained;
  }
  const appended = transcript.appendedEvents;
  const contiguous =
    retained &&
    appended &&
    !transcript.projectionNeedsReconcile &&
    transcript.before.generation === transcript.after.generation;
  const events = [...(contiguous ? retained.tail.events : []), ...(appended ?? [])];
  const coveredAfterSeq = contiguous
    ? retained.tail.coveredAfterSeq
    : (transcript.before.rawSeq ?? -1);
  const next: SessionActorTranscriptReplica = {
    version: transcript.after,
    sessionId: postimage.entry?.sessionId,
    tail: boundedTail(events, appended ? coveredAfterSeq : (transcript.after.rawSeq ?? -1)),
  };
  if (contiguous && retained.context?.rows) {
    const rows = [...retained.context.rows, ...appended];
    const path = simplePath(rows);
    if (path && fits(rows, retained.context.limits)) {
      next.context = {
        limits: retained.context.limits,
        rows,
        ...path,
      };
    }
  }
  return next;
}

export function readSessionActorTranscriptContext(
  retained: SessionActorTranscriptReplica | undefined,
  hot: SessionActorHotState,
  limits: Limits,
  admission?: UserTurnTranscriptAdmissionReceipt,
): Bounded | undefined {
  const context = retained?.context;
  if (
    !retained ||
    !context ||
    retained.sessionId !== hot.entry?.sessionId ||
    !sameSessionActorTranscriptVersion(retained.version, hot.transcript.version) ||
    context.limits.maxBytes !== limits.maxBytes ||
    context.limits.maxEvents !== limits.maxEvents
  ) {
    return undefined;
  }
  if (!context.rows) {
    if (JSON.stringify(context.admission) !== JSON.stringify(admission)) {
      return undefined;
    }
    return structuredClone(context.exact);
  }
  const events = admission
    ? context.rows.filter((row) => row.rawSeq < admission.rawSeq)
    : context.rows;
  const result = readSessionActorBoundedHistory({ hot, events }, limits);
  result.snapshot.totalEvents = context.rows.filter(
    (row) => isRecord(row.event) && row.event.type !== "session",
  ).length;
  if (admission) {
    result.snapshot.activeLeafEntryId = admission.effectiveParentId;
    delete result.snapshot.completeActivePath;
  }
  return result;
}
