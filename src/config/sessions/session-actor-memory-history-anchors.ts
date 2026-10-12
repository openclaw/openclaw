import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import {
  assertSessionActorMemoryAnchor,
  selectSessionActorMemoryAdmittedWindow,
} from "./session-actor-memory-history-context.js";
import { createSessionActorMemoryHistoryNavigation } from "./session-actor-memory-history-navigation.js";
import type { SessionActorMemoryWindow } from "./session-actor-memory-state.js";
import type { SessionTranscriptAnchorSelection } from "./session-transcript-anchor-read.kernel.js";
import type { SessionTranscriptAnchorFacts } from "./session-transcript-anchor-read.types.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";
import type { InternalSessionEntry } from "./types.js";

/** Current logical authority is separate from the selected, possibly historical transcript. */
export function readSessionActorMemoryAnchors(
  window: SessionActorMemoryWindow,
  scope: { agentId: string; path: string; currentEntry: InternalSessionEntry | undefined },
  selection: SessionTranscriptAnchorSelection,
): SessionTranscriptAnchorFacts {
  const current = scope.currentEntry;
  const watermark = window.hot.transcript.watermark;
  const contextAuthority = selection.contextAuthority
    ? {
        entry: current && {
          sessionId: current.sessionId,
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
      current.sessionId !== window.hot.entry?.sessionId ||
      (selection.contextAuthority !== true &&
        current.permissionMode !== selection.contextAuthority.permissionMode))
  ) {
    return { anchors: [], contextAuthority };
  }
  const replay = selection.replayValidation;
  let replayValidated: SessionTranscriptAnchorFacts["replayValidated"];
  if (replay) {
    if (!current && replay.allowInitial && window.events.length === 0) {
      replayValidated = "initial";
    } else if (
      !current ||
      current.sessionId !== window.hot.entry?.sessionId ||
      (replay.expectedLifecycleRevision !== undefined &&
        current.lifecycleRevision !== replay.expectedLifecycleRevision) ||
      (replay.expectedWriterRunId !== undefined &&
        current.activeWriterRunId !== replay.expectedWriterRunId)
    ) {
      throw new SessionTranscriptWriterClaimReboundError();
    } else {
      replayValidated = "current";
    }
  }
  const context = selection.contextValidation;
  if (context?.through) {
    const expected = context.expectedAuthority;
    if (
      expected &&
      (!current ||
        current.sessionId !== window.hot.entry?.sessionId ||
        current.permissionMode !== expected.permissionMode ||
        (current.lifecycleRevision ?? null) !== (expected.lifecycleRevision ?? null))
    ) {
      throw new SessionTranscriptReadFenceError(
        "Session transcript source was deleted, replaced, or changed lifecycle or permissions.",
      );
    }
    assertSessionActorMemoryAnchor(window, scope, context.through);
  }
  // Exact replay buys a new model turn; ordinary snapshots consume their selected prefix.
  if (replay && context && !context.admission && !context.through) {
    const version = window.hot.transcript.version;
    if (
      version.generation !== context.version?.generation ||
      version.rawSeq !== context.version?.rawSeq ||
      version.updatedAt !== context.version?.updatedAt
    ) {
      throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
    }
  }
  if (context?.admission && !replay?.admission) {
    selectSessionActorMemoryAdmittedWindow(window, scope, context.admission);
  }
  const admitted = selectSessionActorMemoryAdmittedWindow(window, scope, replay?.admission);
  const beforeRawSeq = replay?.admission?.rawSeq;
  const available = new Map(
    window.hot.transcript.anchors
      .filter((anchor) => beforeRawSeq === undefined || anchor.rawSeq < beforeRawSeq)
      .map((anchor) => [anchor.entryId, anchor]),
  );
  const selected = selection.entryIds.flatMap((entryId) => available.get(entryId) ?? []);
  const facts: SessionTranscriptAnchorFacts = {
    anchors: selected,
    ...(contextAuthority ? { contextAuthority } : {}),
    ...(context ? { contextValidated: true } : {}),
    ...(replayValidated ? { replayValidated } : {}),
    ...(selection.includeSession
      ? {
          session: current && {
            sessionId: current.sessionId,
            lifecycleRevision: current.lifecycleRevision,
          },
        }
      : {}),
    ...(selection.includeHeader ? { header: window.events[0]?.event } : {}),
    ...(selection.includeWatermark ? { watermark } : {}),
    ...(selection.includeMessagePresence
      ? {
          messagePresence: window.events.some(
            ({ event }) => isRecord(event) && event.type === "message",
          ),
        }
      : {}),
    ...(selection.includeMetadata
      ? {
          metadata: {
            present: window.events.length > 0,
            observedAt: window.hot.transcript.version.updatedAt,
            updatedAt: window.hot.transcript.version.updatedAt,
          },
        }
      : {}),
  };
  if (selection.afterSeq === undefined) {
    return facts;
  }
  const requested = new Map<string, TranscriptEntryAnchor | undefined>(
    selection.entryIds.map((entryId) => [entryId, available.get(entryId)]),
  );
  const visible =
    selection.includeMessagesForRunId === undefined
      ? undefined
      : new Set(
          createSessionActorMemoryHistoryNavigation(admitted).visibleHistory.map(
            (row) => row.rawSeq,
          ),
        );
  const rows = window.events.filter((row) => row.rawSeq > selection.afterSeq!);
  const entries: NonNullable<SessionTranscriptAnchorFacts["tail"]>["entries"] = [];
  for (const { event, rawSeq } of rows) {
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
      ...(includeMessage && anchor && visible?.has(rawSeq) ? { message } : {}),
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
