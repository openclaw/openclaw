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
import { transcriptEventContextEligibility } from "./session-transcript-projection-append.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import { cloneTranscriptView } from "./transcript-snapshot.js";
import { isCanonicalSessionTranscriptEntry } from "./transcript-tree.js";

type Bounded = Extract<PreparedSessionTranscriptHydration, { kind: "bounded" }>;
type Limits = { maxBytes: number; maxEvents: number };
type ContextWindow = {
  header?: SessionActorTranscriptRow;
  rows: SessionActorTranscriptRow[];
  activeLeafEntryId: string | null;
  totalEvents: number;
  earliestFence: number;
  truncatedPrefix: boolean;
  preceding?: Pick<SessionActorTranscriptRow, "rawSeq" | "serializedBytes">;
};

/** A projection owned and evicted by ReplicaCell, never a separate transcript authority. */
export type SessionActorTranscriptReplica = {
  version: SessionTranscriptContextVersion;
  sessionId: string | undefined;
  tail: { events: SessionActorTranscriptRow[]; coveredAfterSeq: number };
  /** Selected positive facts only; an omitted entry is unknown, never absent. */
  anchors?: TranscriptEntryAnchor[];
  context?: {
    limits: Limits;
  } & (
    | {
        rows: SessionActorTranscriptRow[];
        activeLeafEntryId: string | null;
        exact?: never;
        admission?: never;
        window?: never;
      }
    | { rows?: never; exact?: never; admission?: never; window: ContextWindow }
    | {
        rows?: never;
        window?: never;
        exact: Bounded;
        admission?: UserTurnTranscriptAdmissionReceipt;
      }
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

function simplePath(rows: SessionActorTranscriptRow[], parent: string | null = null) {
  let activeLeafEntryId = parent;
  for (const { event } of rows) {
    if (!isRecord(event)) {
      return undefined;
    }
    if (event.type === "session") {
      continue;
    }
    // Boundary controls need the canonical reader; ordinary metadata stays in the complete path.
    if (
      !isCanonicalSessionTranscriptEntry(event) ||
      ["reset", "compaction", "branch_summary"].includes(event.type) ||
      event.appendMode === "side" ||
      typeof event.id !== "string" ||
      event.parentId !== activeLeafEntryId ||
      transcriptEventContextEligibility(event) === 0
    ) {
      return undefined;
    }
    activeLeafEntryId = event.id;
  }
  return { activeLeafEntryId };
}

function fits(rows: SessionActorTranscriptRow[], limits: Limits): boolean {
  return (
    rows.filter((row) => !isRecord(row.event) || row.event.type !== "session").length <=
      limits.maxEvents &&
    rows.reduce((bytes, row) => bytes + row.serializedBytes, 0) <= limits.maxBytes
  );
}

function hasCacheTtl(rows: SessionActorTranscriptRow[]): boolean {
  return rows.some(
    ({ event }) =>
      isRecord(event) && event.type === "custom" && event.customType === "openclaw.cache-ttl",
  );
}

function boundedContextWindow(window: ContextWindow, limits: Limits): ContextWindow {
  const rows = [...window.rows];
  let bytes =
    (window.header?.serializedBytes ?? 0) + rows.reduce((sum, row) => sum + row.serializedBytes, 0);
  let preceding = window.preceding;
  // Keep bounded append slack so an admitted input need not evict its pre-input context.
  while (rows.length > limits.maxEvents + 128 || bytes > limits.maxBytes + 512 * 1024) {
    const removed = rows.shift()!;
    bytes -= removed.serializedBytes;
    preceding = { rawSeq: removed.rawSeq, serializedBytes: removed.serializedBytes };
  }
  return {
    ...window,
    rows,
    preceding,
    truncatedPrefix: window.truncatedPrefix || Boolean(preceding),
  };
}

function seedContextWindow(
  current: SessionActorTranscriptReplica,
  snapshot: Bounded["snapshot"],
  rows: SessionActorTranscriptRow[],
  limits: Limits,
  admission?: UserTurnTranscriptAdmissionReceipt,
): ContextWindow | undefined {
  if (snapshot.boundaryCount !== 0 || snapshot.cacheTtlProjectionPrefixes?.length) {
    return undefined;
  }
  const selected = rows.filter(({ event }) => !isRecord(event) || event.type !== "session");
  const first = selected[0];
  const last = selected.at(-1);
  if (
    !first ||
    !last ||
    !isRecord(first.event) ||
    !isRecord(last.event) ||
    typeof first.event.id !== "string" ||
    (first.event.parentId !== null && typeof first.event.parentId !== "string") ||
    snapshot.parents.get(first.event.id) !== first.event.parentId ||
    snapshot.activeLeafEntryId !== last.event.id ||
    !simplePath(selected, first.event.parentId)
  ) {
    return undefined;
  }
  const appended = current.tail.events.filter((row) => row.rawSeq > last.rawSeq);
  const path = simplePath(appended, snapshot.activeLeafEntryId);
  const candidates = [...selected, ...appended];
  if (
    !path ||
    candidates.at(-1)?.rawSeq !== current.version.rawSeq ||
    appended.some(({ event }) => isRecord(event) && event.type === "session") ||
    hasCacheTtl(candidates)
  ) {
    return undefined;
  }
  return boundedContextWindow(
    {
      header: rows.find(({ event }) => isRecord(event) && event.type === "session"),
      rows: candidates,
      activeLeafEntryId: path.activeLeafEntryId,
      totalEvents: snapshot.totalEvents,
      earliestFence: admission?.rawSeq ?? (current.version.rawSeq ?? -1) + 1,
      truncatedPrefix: snapshot.truncated,
    },
    limits,
  );
}

function readContextWindow(
  window: ContextWindow,
  hot: SessionActorHotState,
  limits: Limits,
  admission?: UserTurnTranscriptAdmissionReceipt,
): Bounded | undefined {
  if (
    admission &&
    (admission.rawSeq < window.earliestFence ||
      (window.preceding && admission.rawSeq <= window.preceding.rawSeq))
  ) {
    return undefined;
  }
  const rows = admission ? window.rows.filter((row) => row.rawSeq < admission.rawSeq) : window.rows;
  const result = readSessionActorBoundedHistory(
    {
      hot,
      events: [...(window.header ? [window.header] : []), ...rows],
    },
    limits,
  );
  const snapshot = result.snapshot;
  if (
    !snapshot.truncated &&
    window.preceding &&
    rows.length < limits.maxEvents &&
    snapshot.serializedBytes + window.preceding.serializedBytes <= limits.maxBytes
  ) {
    // The omitted predecessor could fit after this fence; only the reader owns its payload.
    return undefined;
  }
  const first = rows[0]?.event;
  if (
    isRecord(first) &&
    typeof first.id === "string" &&
    snapshot.parents.has(first.id) &&
    (first.parentId === null || typeof first.parentId === "string")
  ) {
    snapshot.parents.set(first.id, first.parentId);
  }
  snapshot.totalEvents = window.totalEvents;
  snapshot.activeLeafEntryId = admission ? admission.effectiveParentId : window.activeLeafEntryId;
  snapshot.truncated ||= window.truncatedPrefix;
  if (snapshot.activeLeafEntryId && rows.length === 0) {
    snapshot.opaqueParents.set(snapshot.activeLeafEntryId, null);
  }
  delete snapshot.completeActivePath;
  return result;
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

function boundedAnchors(anchors: readonly TranscriptEntryAnchor[]): TranscriptEntryAnchor[] {
  const selected = new Map<string, TranscriptEntryAnchor>();
  for (const anchor of anchors) {
    selected.delete(anchor.entryId);
    selected.set(anchor.entryId, anchor);
  }
  const retained: TranscriptEntryAnchor[] = [];
  let bytes = 0;
  for (const anchor of [...selected.values()].toReversed()) {
    bytes += Object.values(anchor).reduce<number>(
      (size, value) => size + (typeof value === "string" ? value.length * 2 : 8),
      128,
    );
    if (retained.length === 128 || bytes > 128 * 1024) {
      break;
    }
    retained.push(anchor);
  }
  return retained.toReversed();
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
    anchors: previous.anchors?.map((anchor) => ({
      ...anchor,
      generation: postimage.transcript.version.generation ?? anchor.generation,
    })),
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
  if (previous.context?.window) {
    const window = previous.context.window;
    const covered = new Set(window.rows.map((row) => row.rawSeq));
    if (window.preceding) {
      covered.add(window.preceding.rawSeq);
    }
    const shrinksUnknownPrefix =
      window.truncatedPrefix &&
      !window.preceding &&
      window.rows.some(
        (row) =>
          (rewritten.get(row.rawSeq)?.serializedBytes ?? row.serializedBytes) < row.serializedBytes,
      );
    if ([...rewritten.keys()].every((seq) => covered.has(seq)) && !shrinksUnknownPrefix) {
      const preceding = window.preceding && {
        rawSeq: window.preceding.rawSeq,
        serializedBytes:
          rewritten.get(window.preceding.rawSeq)?.serializedBytes ??
          window.preceding.serializedBytes,
      };
      next.context = {
        limits: previous.context.limits,
        window: boundedContextWindow(
          { ...window, rows: patch(window.rows), preceding },
          previous.context.limits,
        ),
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
  const anchors = boundedAnchors([
    ...(current.anchors ?? []),
    ...(prepared.transcript?.anchors ?? []),
  ]);
  if (!prepared.residentRows && current.context) {
    return { ...current, anchors };
  }
  // Own one detached window; row views share it, and worker/cohort facts stay with the read.
  const snapshot = cloneTranscriptView(prepared.snapshot);
  const rows = prepared.residentRows?.map((row, index) => ({
    ...row,
    event: snapshot.events[index],
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
    if (
      candidates.filter((row) => isRecord(row.event) && row.event.type !== "session").length ===
        prepared.snapshot.totalEvents &&
      simplePath(candidates) &&
      fits(candidates, limits)
    ) {
      complete = candidates;
    }
  }
  const window =
    !complete && rows ? seedContextWindow(current, snapshot, rows, limits, admission) : undefined;
  return {
    ...current,
    anchors,
    context: complete
      ? {
          limits: { ...limits },
          rows: complete,
          activeLeafEntryId: prepared.snapshot.activeLeafEntryId,
        }
      : window
        ? { limits: { ...limits }, window }
        : {
            limits: { ...limits },
            exact: { kind: "bounded", snapshot },
            admission: admission && { ...admission },
          },
  };
}

export function advanceSessionActorTranscriptReplica(
  previous: SessionActorTranscriptReplica | undefined,
  outcome: Extract<SessionActorOutcome<unknown>, { kind: "committed" }>,
): SessionActorTranscriptReplica {
  const { transcript, postimage } = outcome.receipt;
  const rewrite = transcript.append?.modelPromptProjection;
  const before = rewrite?.after ?? transcript.before;
  const projected = rewrite
    ? rewriteSessionActorTranscriptReplica(previous, {
        before: rewrite.before,
        postimage: {
          ...postimage,
          transcript: { ...postimage.transcript, version: rewrite.after },
        },
        rows: rewrite.rows,
      })
    : previous;
  const unchanged = sameSessionActorTranscriptVersion(before, transcript.after);
  const retained =
    projected &&
    projected.sessionId === postimage.entry?.sessionId &&
    sameSessionActorTranscriptVersion(projected.version, before)
      ? projected
      : undefined;
  const appendedAnchors = transcript.appendedMessages.flatMap((message) => message.anchor ?? []);
  if (unchanged && retained) {
    return appendedAnchors.length
      ? { ...retained, anchors: boundedAnchors([...(retained.anchors ?? []), ...appendedAnchors]) }
      : retained;
  }
  const appended = transcript.appendedEvents;
  const contiguous =
    retained &&
    appended &&
    !transcript.projectionNeedsReconcile &&
    before.generation === transcript.after.generation;
  const events = [...(contiguous ? retained.tail.events : []), ...(appended ?? [])];
  const coveredAfterSeq = contiguous
    ? retained.tail.coveredAfterSeq
    : (transcript.before.rawSeq ?? -1);
  const next: SessionActorTranscriptReplica = {
    version: transcript.after,
    sessionId: postimage.entry?.sessionId,
    anchors: boundedAnchors([...(contiguous ? (retained.anchors ?? []) : []), ...appendedAnchors]),
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
  if (contiguous && retained.context?.window) {
    const window = retained.context.window;
    const path = simplePath(appended, window.activeLeafEntryId);
    if (
      path &&
      !hasCacheTtl(appended) &&
      !appended.some(({ event }) => isRecord(event) && event.type === "session")
    ) {
      next.context = {
        limits: retained.context.limits,
        window: boundedContextWindow(
          {
            ...window,
            rows: [...window.rows, ...appended],
            activeLeafEntryId: path.activeLeafEntryId,
            totalEvents: window.totalEvents + appended.length,
          },
          retained.context.limits,
        ),
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
  if (context.window) {
    return readContextWindow(context.window, hot, limits, admission);
  }
  if (!context.rows) {
    if (JSON.stringify(context.admission) !== JSON.stringify(admission)) {
      return undefined;
    }
    return cloneTranscriptView(context.exact);
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
