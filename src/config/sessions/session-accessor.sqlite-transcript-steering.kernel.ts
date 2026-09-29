import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { isUserMessage } from "../../sessions/user-turn-transcript.message.js";
import {
  normalizePersistedSteerTargetRunId,
  rewritePersistedSteerTargetRunId,
} from "../../sessions/user-turn-transcript.metadata.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptAdmissionReceipt,
} from "../../sessions/user-turn-transcript.types.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import { readTranscriptGenerationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";
import type { InternalSessionEntry } from "./types.js";

export type TranscriptSteeringConfirmationInput = {
  admission: UserTurnTranscriptAdmissionReceipt;
  targetRunId: string;
  foregroundAdmission?: UserTurnTranscriptAdmissionReceipt;
};

export type TranscriptSteeringConfirmation = {
  admission: UserTurnTranscriptAdmissionReceipt;
  message: PersistedUserTurnMessage;
  foregroundAdmission?: UserTurnTranscriptAdmissionReceipt;
};

/** Confirms one accepted steer and certifies only an unchanged earlier admission. */
export function confirmTranscriptSteeringInTransaction(
  database: OpenClawAgentDatabase,
  resolved: ResolvedTranscriptScope,
  input: TranscriptSteeringConfirmationInput,
  options: { scheduleProjectionReconcile?: boolean } = {},
): TranscriptSteeringConfirmation | null {
  const { admission, foregroundAdmission } = input;
  if (
    admission.agentId !== resolved.agentId ||
    admission.sessionId !== resolved.sessionId ||
    admission.sessionKey !== resolved.sessionKey ||
    (admission.storePath !== database.path &&
      readDatabasePathIdentitySync(admission.storePath).canonicalPath !== database.path)
  ) {
    throw new Error("Steering confirmation belongs to another transcript");
  }
  assertSessionTranscriptHot(database.db, resolved.sessionId);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .select(transcriptEventJsonSql(database.db).as("event_json"))
      .where("session_id", "=", resolved.sessionId)
      .where("seq", "=", admission.rawSeq),
  );
  if (!row) {
    return null;
  }
  const event: unknown = JSON.parse(row.event_json);
  if (
    !isRecord(event) ||
    event.type !== "message" ||
    event.id !== admission.entryId ||
    !isUserMessage(event.message) ||
    normalizePersistedSteerTargetRunId(event.message["__openclaw"]?.steerTargetRunId) ===
      input.targetRunId
  ) {
    return null;
  }
  let preserveForeground = false;
  if (foregroundAdmission) {
    const {
      logicalTurnId: _foregroundTurnId,
      role: _foregroundRole,
      ...foregroundAnchor
    } = foregroundAdmission;
    const { logicalTurnId: _steeringTurnId, role: _steeringRole, ...steeringAnchor } = admission;
    // The foreground's current generation certifies its earlier prefix. A
    // queued steer may predate another confirmed steer, but must retain its
    // exact later row identity in that same current generation.
    preserveForeground =
      foregroundAdmission.agentId === admission.agentId &&
      foregroundAdmission.storePath === admission.storePath &&
      foregroundAdmission.sessionId === admission.sessionId &&
      foregroundAdmission.sessionKey === admission.sessionKey &&
      foregroundAdmission.rawSeq < admission.rawSeq &&
      foregroundAdmission.activeMessagePosition < admission.activeMessagePosition &&
      isDeepStrictEqual(
        readActiveTranscriptEntryAnchorInTransaction({
          database,
          resolved,
          entryId: admission.entryId,
        }),
        {
          ...steeringAnchor,
          storePath: database.path,
          generation: foregroundAdmission.generation,
        },
      ) &&
      isDeepStrictEqual(
        readActiveTranscriptEntryAnchorInTransaction({
          database,
          resolved,
          entryId: foregroundAdmission.entryId,
        }),
        { ...foregroundAnchor, storePath: database.path },
      );
  }
  const message = rewritePersistedSteerTargetRunId(event.message, input.targetRunId);
  if (!message) {
    return null;
  }
  rewriteSqliteTranscriptEventRowsInTransaction(
    database,
    resolved,
    [{ event: { ...event, message }, expectedEventJson: row.event_json, seq: admission.rawSeq }],
    options,
  );
  const generation = readTranscriptGenerationInTransaction(database, resolved.sessionId);
  if (!generation) {
    throw new Error("Steering confirmation lost its transcript generation");
  }
  return {
    admission: { ...admission, generation },
    message,
    ...(preserveForeground && foregroundAdmission
      ? { foregroundAdmission: { ...foregroundAdmission, generation } }
      : {}),
  };
}

export function resolveTranscriptSteeringConfirmationRefusal(
  entry: InternalSessionEntry | undefined,
  resolved: ResolvedTranscriptScope,
  scope: SessionTranscriptWriteScope,
): TranscriptAppendRefusal | undefined {
  // Turn admission also supports scopes without a logical session entry.
  // Confirm their exact anchored row only when no current writer or lifecycle
  // was required; a present entry must still select this transcript.
  if (
    !entry &&
    scope.expectedLifecycleRevision === undefined &&
    scope.expectedWriterRunId === undefined
  ) {
    return undefined;
  }
  return resolveTranscriptAppendRefusal(entry, resolved, scope);
}
