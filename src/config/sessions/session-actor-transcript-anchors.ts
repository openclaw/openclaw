import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import type { SessionActorHotState } from "./session-actor-state.types.js";
import type { SessionTranscriptAnchorSelection } from "./session-transcript-anchor-read.kernel.js";
import type { SessionTranscriptAnchorFacts } from "./session-transcript-anchor-read.types.js";
import {
  resolveSqliteSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "./session-transcript-read-fence.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import {
  sameTranscriptEntryAnchor,
  type TranscriptEntryAnchor,
} from "./transcript-entry-anchor.js";

type TranscriptTail = {
  /** Complete committed suffix, in raw sequence order, through this actor's current watermark. */
  events: readonly { rawSeq: number; event: unknown }[];
  coveredAfterSeq: number;
};

/** Project only facts held by the current actor; unsupported history selections stay with its reader. */
export function readSessionActorTranscriptAnchors(
  hot: SessionActorHotState,
  scope: { agentId: string; path: string; sessionId: string },
  selection: SessionTranscriptAnchorSelection,
  tail?: TranscriptTail,
): SessionTranscriptAnchorFacts | undefined {
  if (
    hot.transcript.anchorsState !== "resident" ||
    selection.includeHeader ||
    selection.includeMetadata ||
    selection.activePathEntryId !== undefined
  ) {
    return undefined;
  }
  const current = hot.entry;
  const watermark = hot.transcript.watermark;
  const contextAuthority = selection.contextAuthority
    ? {
        entry: current && {
          sessionId: current.sessionId,
          updatedAt: current.updatedAt,
          lifecycleRevision: current.lifecycleRevision,
          activeWriterRunId: current.activeWriterRunId,
          cliHistoryBoundary: current.cliHistoryBoundary,
          permissionMode: current.permissionMode,
        },
        watermark,
      }
    : undefined;
  if (
    selection.contextAuthority &&
    (!current ||
      current.sessionId !== scope.sessionId ||
      (selection.contextAuthority !== true &&
        current.permissionMode !== selection.contextAuthority.permissionMode))
  ) {
    return { anchors: [], contextAuthority };
  }
  const replay = selection.replayValidation;
  if (replay) {
    // An absent entry alone cannot establish that the durable transcript is also absent.
    if (!current && replay.allowInitial) {
      return undefined;
    }
    if (
      !current ||
      current.sessionId !== scope.sessionId ||
      (replay.expectedLifecycleRevision !== undefined &&
        current.lifecycleRevision !== replay.expectedLifecycleRevision) ||
      (replay.expectedWriterRunId !== undefined &&
        current.activeWriterRunId !== replay.expectedWriterRunId)
    ) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
  }
  if (current?.sessionId !== scope.sessionId) {
    return undefined;
  }
  const resolveFence = (admission: NonNullable<typeof replay>["admission"]) =>
    runWithSessionTranscriptReadFence(admission, () =>
      resolveSqliteSessionTranscriptReadFence({
        database: { path: scope.path },
        ...scope,
        sessionKey: hot.target.sessionKey,
      }),
    );
  const fence = replay ? resolveFence(replay.admission) : undefined;
  const context = selection.contextValidation;
  if (context?.admission && !resolveFence(context.admission)) {
    throw new SessionTranscriptReadFenceError(
      "Current-turn transcript admission is no longer readable",
    );
  }
  if (context?.through) {
    const through = context.through;
    if (
      through.agentId !== scope.agentId ||
      through.storePath !== scope.path ||
      through.sessionId !== scope.sessionId ||
      through.sessionKey !== hot.target.sessionKey
    ) {
      throw new SessionTranscriptReadFenceError(
        "Completed-turn anchor belongs to another transcript",
      );
    }
    const expected = context.expectedAuthority;
    if (
      expected &&
      (!current ||
        current.sessionId !== scope.sessionId ||
        current.permissionMode !== expected.permissionMode ||
        (current.lifecycleRevision ?? null) !== (expected.lifecycleRevision ?? null))
    ) {
      throw new SessionTranscriptReadFenceError(
        "Session transcript source was deleted, replaced, or changed lifecycle or permissions.",
      );
    }
    if (
      !sameTranscriptEntryAnchor(
        through,
        hot.transcript.anchors.find((anchor) => anchor.entryId === through.entryId),
      )
    ) {
      throw new SessionTranscriptReadFenceError("Completed-turn transcript anchor changed");
    }
  } else if (context && !context.admission) {
    const version = hot.transcript.version;
    if (
      version.generation !== context.version?.generation ||
      version.rawSeq !== context.version?.rawSeq ||
      version.updatedAt !== context.version?.updatedAt
    ) {
      if (!replay) {
        // Prefix validation needs historical navigation that the hot projection does not retain.
        return undefined;
      }
      throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
    }
  }
  const messagePresence = tail?.events.some(
    ({ event }) => asOptionalRecord(event)?.type === "message",
  );
  if (selection.includeMessagePresence && !messagePresence && tail?.coveredAfterSeq !== -1) {
    return undefined;
  }
  const available = new Map(
    hot.transcript.anchors
      .filter((anchor) => !fence || anchor.rawSeq < fence.beforeRawSeq)
      .map((anchor) => [anchor.entryId, anchor]),
  );
  const selected = selection.entryIds.flatMap((entryId) => available.get(entryId) ?? []);
  const facts: SessionTranscriptAnchorFacts = {
    anchors: selected,
    ...(contextAuthority ? { contextAuthority } : {}),
    ...(context ? { contextValidated: true } : {}),
    ...(replay ? { replayValidated: "current" } : {}),
    ...(selection.includeSession
      ? {
          session: current && {
            sessionId: current.sessionId,
            lifecycleRevision: current.lifecycleRevision,
          },
        }
      : {}),
    ...(selection.includeWatermark ? { watermark } : {}),
    ...(selection.includeMessagePresence ? { messagePresence: messagePresence ?? false } : {}),
  };
  if (selection.afterSeq === undefined) {
    return facts;
  }
  if (!tail || selection.afterSeq < tail.coveredAfterSeq) {
    return undefined;
  }
  const rows = tail.events.filter((row) => row.rawSeq > selection.afterSeq!);
  if (
    selection.includeMessagesForRunId !== undefined &&
    rows.some(({ event }) => asOptionalRecord(event)?.type === "reset")
  ) {
    // A reset can hide earlier messages while retaining their active anchors.
    return undefined;
  }
  const requested = new Map<string, TranscriptEntryAnchor | undefined>(
    selection.entryIds.map((entryId) => [entryId, available.get(entryId)]),
  );
  const entries: NonNullable<SessionTranscriptAnchorFacts["tail"]>["entries"] = [];
  for (const { event } of rows) {
    const row = asOptionalRecord(event);
    const message = asOptionalRecord(row?.message);
    if (
      typeof row?.id !== "string" ||
      (message?.role !== "user" && message?.role !== "assistant")
    ) {
      continue;
    }
    const runId = readSessionTranscriptRunId(message);
    const includeMessage =
      selection.includeMessagesForRunId !== undefined &&
      message.role === "assistant" &&
      runId === selection.includeMessagesForRunId;
    const anchor =
      message.role === "user" || includeMessage ? available.get(row.id) : requested.get(row.id);
    if (message.role === "user" || includeMessage) {
      requested.set(row.id, anchor);
    }
    entries.push({
      entryId: row.id,
      role: message.role,
      ...(runId ? { runId } : {}),
      ...(anchor ? { anchor } : {}),
      ...(includeMessage && anchor ? { message } : {}),
    });
  }
  return {
    ...facts,
    anchors: selection.includeMessagesForRunId
      ? [...requested.values()].flatMap((anchor) => anchor ?? [])
      : selected,
    tail: { lastSeq: rows.at(-1)?.rawSeq, entries },
  };
}
