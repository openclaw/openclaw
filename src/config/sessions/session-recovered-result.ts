import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { isAssistantResultEventForRun } from "../../sessions/transcript-visible-record.js";
import { buildRunUserTurnIdempotencyKey } from "../../sessions/user-turn-transcript.metadata.js";
import {
  readTranscriptEventId,
  readTranscriptEventMessage,
} from "./session-accessor.sqlite-read.js";
import { withTranscriptWriteSequence } from "./session-accessor.sqlite-transcript-write.js";
import { persistSessionTranscriptTurn } from "./session-accessor.transcript-turn.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import {
  readSessionEntryReadOnlyInWorker,
  withSessionEntryReadOnlyInWorker,
} from "./session-entry-read-runtime.js";
import { readSessionTranscriptAnchorsAsync } from "./session-transcript-anchor-read.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import { findTranscriptEvent } from "./session-transcript-match.js";
import {
  buildSessionTranscriptTurnExpectedState,
  sessionMatchesExpectedTranscriptTurn,
} from "./session-transcript-turn-state.js";
import type { InternalSessionEntry } from "./types.js";

type RecoveryWriter = SessionTranscriptRuntimeTarget & { lifecycleRevision: string; runId: string };

export type SessionRecoveredResultTarget = RecoveryWriter & { assertCurrent: () => void };

function expectedWriter(target: RecoveryWriter) {
  return {
    expectedSessionId: target.sessionId,
    expectedLifecycleRevision: target.lifecycleRevision,
    expectedWriterRunId: target.runId,
  };
}

export function isCurrentRecoveryWriter(
  target: RecoveryWriter,
  row: InternalSessionEntry | undefined,
): row is InternalSessionEntry {
  return (
    row !== undefined &&
    sessionMatchesExpectedTranscriptTurn({ entry: row }, expectedWriter(target)) &&
    row.archivedAt === undefined &&
    !row.abortedLastRun
  );
}

class SessionRecoveredResultConflictError extends Error {
  override name = "SessionRecoveredResultConflictError";

  constructor() {
    super("Interrupted worker transcript has conflicting terminal evidence");
  }
}

async function readTranscriptVersion(
  target: Parameters<typeof readSessionTranscriptAnchorsAsync>[0],
): Promise<SessionTranscriptContextVersion | undefined> {
  const { metadata, watermark } = await readSessionTranscriptAnchorsAsync(target, {
    entryIds: [],
    includeMetadata: true,
    includeWatermark: true,
  });
  return metadata && watermark
    ? { generation: watermark.generation, rawSeq: watermark.maxSeq, updatedAt: metadata.updatedAt }
    : undefined;
}

/** Reconcile the active result under the original writer, fencing fresh insertion by transcript version. */
export async function readOrPreserveRecoveredSessionResult(
  recovery: SessionRecoveredResultTarget,
  artifactModel: string,
  write?: { idempotencyKey: string; message: unknown },
): Promise<Record<string, unknown> | undefined> {
  const { assertCurrent, lifecycleRevision, runId, ...scope } = recovery;
  return withSessionEntryReadOnlyInWorker(scope, assertCurrent, async (read, owner) => {
    if (!read.ok) {
      throw read.error;
    }
    const row = read.value;
    if (!isCurrentRecoveryWriter(recovery, row) || owner.kind !== "file" || !owner.scope) {
      return undefined;
    }
    const target = { ...scope, storePath: owner.scope.storePath, env: owner.scope.env };
    const assertOwner = () => {
      assertCurrent();
      owner.assertCurrent();
    };
    // Protect the absence check against another process changing the transcript.
    const version = await readTranscriptVersion(target);
    if (!version) {
      return undefined;
    }
    const inputKey = buildRunUserTurnIdempotencyKey(runId);
    assertOwner();
    const facts = await withTranscriptWriteSequence(
      { ...target, expectedLifecycleRevision: lifecycleRevision, expectedWriterRunId: runId },
      (writer) =>
        writer.readMessageFacts({
          idempotencyKeys: write ? [inputKey, write.idempotencyKey] : [inputKey],
          activeBranchOnly: true,
          sourceRunId: runId,
        }),
    );
    assertOwner();
    const terminals = facts.sourceEvents?.flatMap((event) => {
      const message = readTranscriptEventMessage(event);
      const recovered = message?.model === artifactModel;
      return recovered ||
        asOptionalRecord(message?.["__openclaw"])?.runTerminal === true ||
        isAssistantResultEventForRun(event, runId)
        ? [{ id: readTranscriptEventId(event), message, recovered }]
        : [];
    });
    if (!terminals || (!write && !terminals.some((terminal) => terminal.recovered))) {
      return undefined;
    }
    const prior = terminals[0];
    if (
      terminals.length > 1 ||
      (prior && (!prior.id || !prior.message)) ||
      (!prior && write && facts.existingIdempotencyKeys.has(write.idempotencyKey))
    ) {
      throw new SessionRecoveredResultConflictError();
    }
    // Without the original input, the reader only searches a recent legacy window.
    if (asOptionalRecord(facts.messagesByIdempotencyKey.get(inputKey))?.["role"] !== "user") {
      if (prior) {
        throw new SessionRecoveredResultConflictError();
      }
      return undefined;
    }

    let entryId = prior?.id;
    if (!entryId && write) {
      assertOwner();
      const result = await persistSessionTranscriptTurn(target, {
        assertCurrent: assertOwner,
        acceptedResultGuard: {
          expectedWriterRunId: runId,
          errorMessage: "Interrupted worker transcript writer changed",
        },
        ...expectedWriter(recovery),
        expectedSessionState: buildSessionTranscriptTurnExpectedState(row),
        runId,
        touchSessionEntry: true,
        messages: [
          {
            message: write.message,
            idempotencyLookup: "scan-assistant",
            expectedTranscript: version,
          },
        ],
      });
      entryId = result.messages[0]?.messageId;
    }
    if (!entryId) {
      return undefined;
    }

    const found = await findTranscriptEvent(
      target,
      { kind: "visible-final", runId },
      undefined,
      "subagent-final-answer",
    );
    const saved = found && readTranscriptEventMessage(found.event);
    if (
      !found ||
      readTranscriptEventId(found.event) !== entryId ||
      !saved ||
      asOptionalRecord(saved["__openclaw"])?.runId !== runId ||
      (write && saved.idempotencyKey !== write.idempotencyKey)
    ) {
      throw new SessionRecoveredResultConflictError();
    }
    if (
      (prior && !isDeepStrictEqual(await readTranscriptVersion(target), version)) ||
      !isCurrentRecoveryWriter(
        recovery,
        await readSessionEntryReadOnlyInWorker(target, assertOwner),
      )
    ) {
      throw new SessionRecoveredResultConflictError();
    }
    return saved;
  });
}
