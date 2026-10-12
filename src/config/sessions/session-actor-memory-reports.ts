import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import type { TranscriptAppendRefusal } from "./session-accessor.sqlite-contract.js";
import type {
  AbortedSessionTranscriptPartialResult,
  TranscriptReportCommit,
} from "./session-accessor.sqlite-transcript-reports.types.js";
import type { SessionTranscriptWriteLockAccessorContext } from "./session-accessor.types.js";
import { createSessionActorMemoryEvents } from "./session-actor-memory-events.js";
import { createSessionActorMemoryMessages } from "./session-actor-memory-messages.js";
import type {
  SessionActorMemoryReportsCommand,
  SessionActorMemoryReportsReads,
  SessionActorMemoryReportsWrites,
} from "./session-actor-memory-reports-contract.js";
import type { SessionActorMemoryStorageContext } from "./session-actor-memory-storage-context.js";
import { commitSessionActorMemoryWorkerTranscript } from "./session-actor-memory-worker-transcript.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import { projectSessionTranscriptReportFacts } from "./session-transcript-report-facts.js";
import {
  selectTranscriptReport,
  hasSettledTranscriptAssistant,
  TranscriptReportNavigation,
} from "./session-transcript-report-policy.js";
import { isSteerConfirmationRewrite } from "./session-transcript-rewrite-effects.js";
import { sessionMatchesExpectedTranscriptTurn } from "./session-transcript-turn-state.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import { canonicalizeTranscriptEventMedia } from "./transcript-event-media.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import { selectVisibleTranscriptEvents } from "./transcript-visible-events.js";

type Operations = SessionActorMemoryReportsReads & SessionActorMemoryReportsWrites;
export function executeSessionActorMemoryReportCommand<Key extends keyof Operations>(
  context: SessionActorMemoryStorageContext,
  command: { type: Key; input: Operations[Key]["input"] },
): Operations[Key]["output"];
export function executeSessionActorMemoryReportCommand(
  context: SessionActorMemoryStorageContext,
  command: SessionActorMemoryReportsCommand,
): Operations[keyof Operations]["output"] {
  const { state, agentId, path } = context;
  const { scope } = command.input;
  if (
    scope.sessionKey !== state.hot.target.sessionKey ||
    (scope.agentId !== undefined && scope.agentId !== agentId) ||
    (scope.storePath !== undefined && scope.storePath !== path)
  ) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  const entry = state.hot.entry;
  const refusal: TranscriptAppendRefusal | undefined = sessionMatchesExpectedTranscriptTurn(
    entry ? { entry } : undefined,
    { ...scope, expectedSessionId: scope.sessionId },
  )
    ? undefined
    : {
        agentIdHash: redactIdentifier(agentId),
        expectedSessionIdHash: redactIdentifier(scope.sessionId),
        sessionKeyHash: redactIdentifier(scope.sessionKey),
        ...(entry
          ? {
              actualSessionIdHash: redactIdentifier(entry.sessionId),
              code: "session-rebound" as const,
            }
          : { code: "session-entry-missing" as const }),
      };
  if (refusal || !entry) {
    if (command.type.startsWith("session.report.")) {
      return { ok: false, error: refusal! };
    }
    throw new SessionTranscriptWriterClaimReboundError(refusal);
  }
  const events = createSessionActorMemoryEvents(context);
  const { appendMessage } = createSessionActorMemoryMessages(context, events);
  const readEvent = (seq: number) =>
    asOptionalRecord(state.events.find((row) => row.rawSeq === seq)?.event);
  const branch = () =>
    new TranscriptReportNavigation(
      state.events.map((row) => ({
        seq: row.rawSeq,
        facts: projectSessionTranscriptReportFacts(row.event),
      })),
    ).facts();
  const versionMatches = (expected: typeof state.hot.transcript.version) => {
    const current = state.hot.transcript.version;
    return (
      current.generation === expected.generation &&
      current.rawSeq === expected.rawSeq &&
      current.updatedAt === expected.updatedAt
    );
  };
  const commit = (
    committed: boolean,
    extra: Partial<TranscriptReportCommit> = {},
  ): { ok: true; value: TranscriptReportCommit } => ({
    ok: true,
    value: { committed, projectionNeedsReconcile: false, ...extra },
  });
  switch (command.type) {
    case "session.transcript.messageFacts": {
      const facts: Awaited<
        ReturnType<SessionTranscriptWriteLockAccessorContext["readMessageFacts"]>
      > = {
        anchorsByIdempotencyKey: new Map(),
        existingIdempotencyKeys: new Set(),
        messagesByIdempotencyKey: new Map(),
      };
      const keys = new Set(command.input.idempotencyKeys);
      for (const row of state.events) {
        const event = asOptionalRecord(row.event);
        const key = readMessageIdempotencyKey(event?.message);
        if (!key || !keys.has(key)) {
          continue;
        }
        facts.existingIdempotencyKeys.add(key);
        facts.messagesByIdempotencyKey.set(key, event?.message);
        const anchor = state.hot.transcript.anchors.find((item) => item.entryId === event?.id);
        if (anchor) {
          facts.anchorsByIdempotencyKey.set(key, anchor);
        }
      }
      const runId = command.input.sourceRunId;
      if (runId) {
        facts.sourceEvents = selectVisibleTranscriptEvents(
          state.events.map((row) => row.event),
        ).filter((event) => readSessionTranscriptRunId(asOptionalRecord(event)?.message) === runId);
      }
      return { version: events.version(), facts };
    }
    case "session.report.prepare":
      return {
        ok: true,
        value: {
          facts: selectTranscriptReport(branch(), readEvent, command.input.selection),
          version: events.version(),
        },
      };
    case "session.report.append": {
      if (!versionMatches(command.input.version)) {
        return commit(false);
      }
      if (!state.events.length) {
        events.writeEvent(createSessionTranscriptHeader({ sessionId: entry.sessionId }));
      }
      const { eventJson } = command.input.report;
      if (!events.appendRaw(JSON.parse(eventJson), {}, eventJson).appended) {
        throw new Error("Session transcript report was not appended");
      }
      return commit(true);
    }
    case "session.report.assistant": {
      const { report } = command.input;
      const facts = selectTranscriptReport(branch(), readEvent, {
        kind: "assistant",
        responseId: report.message.responseId,
      });
      if (!facts.suppressed) {
        appendMessage({
          message: report.preparedMessage.persistedMessage,
          messageJson: report.preparedMessage.messageJson,
          parentId: facts.appendParentId,
        });
      }
      return commit(!facts.suppressed);
    }
    case "session.report.abortedPartial": {
      const partial = command.input.report;
      if (
        partial.expectedLifecycleRevision !== undefined &&
        entry.lifecycleRevision !== (partial.expectedLifecycleRevision ?? undefined)
      ) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
      const navigation = branch();
      const settled = hasSettledTranscriptAssistant(navigation, readEvent, partial.runId);
      if (settled) {
        return commit(false, { abortedPartial: { skipped: true } });
      }
      if (entry.activeWriterRunId !== undefined && entry.activeWriterRunId !== partial.runId) {
        throw new SessionTranscriptWriterClaimReboundError();
      }
      const append = appendMessage({
        message: partial.preparedMessage.persistedMessage,
        messageJson: partial.preparedMessage.messageJson,
        parentId: navigation.appendParentId,
        idempotencyLookup: "scan-assistant",
        now: partial.now,
        useRawWhenLinear: true,
      }).result;
      if (!append || !isRecord(append.message)) {
        throw new Error("Aborted assistant partial was not appended");
      }
      if (append.appended) {
        state.hot.entry = {
          ...state.hot.entry!,
          updatedAt: Math.max(entry.updatedAt ?? 0, Date.now()),
        };
      }
      const receipt: AbortedSessionTranscriptPartialResult = {
        skipped: false,
        append: { ...append, message: append.message },
        lifecycleRevision: entry.lifecycleRevision,
        ...(append.anchor ? { messageSeq: append.anchor.activeMessagePosition + 1 } : {}),
      };
      return commit(append.appended, {
        abortedPartial: receipt,
        sessionEntryChanged: append.appended,
      });
    }
    case "session.correction.prepare":
      return {
        rows: state.events
          .filter(
            (row) => command.input.afterSeq === undefined || row.rawSeq > command.input.afterSeq,
          )
          .map((row) => ({ seq: row.rawSeq, eventJson: row.eventJson })),
        version: events.version(),
      };
    case "session.correction.commit": {
      const { input } = command;
      const current = events.version();
      if (
        current.generation !== input.version.generation ||
        (!input.allowLaterAppends && !versionMatches(input.version))
      ) {
        if (input.allowLaterAppends) {
          return { kind: "session-transcript-correction", generation: null };
        }
        throw new SqliteTranscriptMutationConflictError(entry.sessionId);
      }
      if (input.rows.length) {
        let preserveGeneration = true;
        const replacements = new Map(
          input.rows.map((row) => {
            const existing = state.events.find(
              (value) => isRecord(value.event) && value.event.id === row.entryId,
            );
            if (!existing || existing.eventJson !== row.expectedEventJson) {
              throw new SqliteTranscriptMutationConflictError(entry.sessionId);
            }
            const eventJson = JSON.stringify(canonicalizeTranscriptEventMedia(row.event));
            preserveGeneration &&= isSteerConfirmationRewrite(row.expectedEventJson, eventJson);
            return [existing.rawSeq, { ...existing, eventJson, event: JSON.parse(eventJson) }];
          }),
        );
        events.replaceRows(
          state.events.map((row) => replacements.get(row.rawSeq) ?? row),
          { preserveGeneration },
        );
      }
      return { kind: "session-transcript-correction", generation: events.version().generation };
    }
    case "session.workerTranscript.commit":
      return commitSessionActorMemoryWorkerTranscript(context, command.input);
    default:
      throw new Error("Unsupported memory transcript operation");
  }
}
