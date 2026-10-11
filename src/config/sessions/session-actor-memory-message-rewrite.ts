import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readSessionTranscriptRunId,
  resolveTerminalAssistantTranscriptRunId,
} from "../../sessions/transcript-events.js";
import { createSessionActorMemoryEvents } from "./session-actor-memory-events.js";
import type {
  SessionActorMemoryReportsReads,
  SessionActorMemoryReportsWrites,
} from "./session-actor-memory-reports-contract.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import { isSteerConfirmationRewrite } from "./session-transcript-rewrite-effects.js";
import { sessionMatchesExpectedTranscriptTurn } from "./session-transcript-turn-state.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import { canonicalizeTranscriptEventMedia } from "./transcript-event-media.js";

export function prepareSessionActorMemoryMessageRewrite(
  { state }: SessionActorMemoryStorageContext,
  input: SessionActorMemoryReportsReads["session.rewrite.prepare"]["input"],
): SessionActorMemoryReportsReads["session.rewrite.prepare"]["output"] {
  const { expectedEntry, target } = input;
  if (
    expectedEntry &&
    (!sessionMatchesExpectedTranscriptTurn(
      state.hot.entry ? { entry: state.hot.entry } : undefined,
      {
        expectedSessionId: input.scope.sessionId,
        expectedLifecycleRevision: expectedEntry.lifecycleRevision,
        expectedOwner: expectedEntry.owner,
      },
    ) ||
      (expectedEntry.activeWriterRunId !== undefined &&
        state.hot.entry?.activeWriterRunId !== (expectedEntry.activeWriterRunId ?? undefined)))
  ) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  if (target.kind === "anchor" && target.active) {
    const active = state.hot.transcript.anchors.find(
      (anchor) => anchor.entryId === target.anchor.entryId,
    );
    if (
      target.active === "exact"
        ? !isDeepStrictEqual(active, target.anchor)
        : active?.rawSeq !== target.anchor.rawSeq
    ) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
  }
  const row =
    target.kind === "anchor"
      ? state.events.find((candidate) => candidate.rawSeq === target.anchor.rawSeq)
      : state.events.findLast(
          ({ event }) =>
            isRecord(event) &&
            isRecord(event.message) &&
            readSessionTranscriptRunId(event.message) === target.runId &&
            resolveTerminalAssistantTranscriptRunId(event.message, target.runId) !== undefined,
        );
  if (
    !row ||
    !isRecord(row.event) ||
    row.event.type !== "message" ||
    typeof row.event.id !== "string" ||
    (target.kind === "anchor" && row.event.id !== target.anchor.entryId)
  ) {
    return null;
  }
  return { seq: row.rawSeq, eventJson: row.eventJson, event: structuredClone(row.event) };
}

export function commitSessionActorMemoryMessageRewrite(
  context: SessionActorMemoryStorageContext,
  input: SessionActorMemoryReportsWrites["session.rewrite.commit"]["input"],
): SessionActorMemoryReportsWrites["session.rewrite.commit"]["output"] {
  const current = prepareSessionActorMemoryMessageRewrite(context, input);
  if (
    !current ||
    current.seq !== input.expected.seq ||
    current.eventJson !== input.expected.eventJson
  ) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  const changed = input.message !== undefined;
  if (changed) {
    const event = canonicalizeTranscriptEventMedia({ ...current.event, message: input.message });
    const eventJson = JSON.stringify(event);
    createSessionActorMemoryEvents(context).replaceRows(
      context.state.events.map((row) =>
        row.rawSeq === current.seq ? { ...row, event, eventJson } : row,
      ),
      { preserveGeneration: isSteerConfirmationRewrite(current.eventJson, eventJson) },
    );
  }
  const generation = context.state.hot.transcript.version.generation;
  return {
    kind: "session-message-rewrite",
    result:
      generation && (changed || input.target.kind === "terminal-assistant")
        ? {
            generation,
            messageId: String(current.event.id),
            message: changed ? input.message : current.event.message,
          }
        : null,
  };
}
