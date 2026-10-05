import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getUserTurnTranscriptAdmissionOwner,
  readPendingUserTurnTranscriptAdmission,
} from "../../sessions/user-turn-transcript-admission.js";
import type {
  UserTurnTranscriptAdmissionReceipt,
  UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.types.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";
import { transcriptEventNavigationSql } from "./transcript-payload.js";
import { getOwnedSessionTranscriptWriterFence } from "./transcript-write-context.js";

export { SessionTranscriptReadFenceError };

const transcriptReadFenceStorage = new AsyncLocalStorage<UserTurnTranscriptAdmissionReceipt>();
const log = createSubsystemLogger("sessions/transcript-read-fence");

function identityHash(value: string | null): string | null {
  return value === null ? null : createHash("sha256").update(value).digest("hex");
}

function isSameTranscriptStore(left: string, right: string): boolean {
  return left === right || isSameOpenClawAgentDatabasePath(left, right);
}

type QuestionAnswerScope = {
  recorder: UserTurnTranscriptRecorder | undefined;
  assertActive: () => void;
  inputs: Map<string, UserTurnTranscriptAdmissionReceipt>;
};
const questionAnswerStorage = new AsyncLocalStorage<QuestionAnswerScope>();

/** Answer custody outlives question registration, but never the creator's admitted run. */
export function withSessionTranscriptQuestionAnswers<T>(
  recorder: UserTurnTranscriptRecorder | undefined,
  assertActive: () => void,
  run: (admitAnswer: (source: UserTurnTranscriptRecorder | undefined) => void) => T,
): T {
  const scope: QuestionAnswerScope = { recorder, assertActive, inputs: new Map() };
  return questionAnswerStorage.run(scope, () =>
    run((source) => {
      scope.assertActive();
      const creator = scope.recorder && getUserTurnTranscriptAdmissionOwner(scope.recorder);
      const original = creator?.receipt();
      const input = readPendingUserTurnTranscriptAdmission(source);
      if (
        original &&
        input &&
        !creator?.blocked() &&
        input.agentId === original.agentId &&
        input.sessionId === original.sessionId &&
        input.sessionKey === original.sessionKey &&
        isSameTranscriptStore(input.storePath, original.storePath) &&
        input.generation === original.generation
      ) {
        scope.inputs.set(input.entryId, input);
      }
    }),
  );
}

export function resolveSessionTranscriptQuestionAnswer(
  database: Pick<OpenClawAgentDatabase, "path">,
  sessionId: string,
  entryId: string,
  admittedUserId?: string,
): UserTurnTranscriptAdmissionReceipt | undefined {
  const scope = questionAnswerStorage.getStore();
  const input = scope?.inputs.get(entryId);
  if (
    !scope ||
    !input ||
    !isSameTranscriptStore(input.storePath, database.path) ||
    input.sessionId !== sessionId
  ) {
    return undefined;
  }
  scope.assertActive();
  const creator = scope.recorder && getUserTurnTranscriptAdmissionOwner(scope.recorder);
  const original = creator?.receipt();
  return original &&
    !creator?.blocked() &&
    original.agentId === input.agentId &&
    original.sessionId === input.sessionId &&
    original.sessionKey === input.sessionKey &&
    isSameTranscriptStore(original.storePath, input.storePath) &&
    original.generation === input.generation &&
    (admittedUserId === undefined || original.entryId === admittedUserId)
    ? input
    : undefined;
}

type SessionTranscriptReadFence = Readonly<{
  admission: UserTurnTranscriptAdmissionReceipt;
  beforeActiveMessagePosition: number;
  beforeRawSeq: number;
}>;

export function runWithSessionTranscriptReadFence<T>(
  receipt: UserTurnTranscriptAdmissionReceipt | undefined,
  run: () => T,
): T {
  return receipt ? transcriptReadFenceStorage.run(receipt, run) : run();
}

export function withSessionContextAdmission<T>(
  target: SessionTranscriptRuntimeTarget,
  admission: UserTurnTranscriptAdmissionReceipt | undefined,
  read: () => T,
): T {
  if (
    admission &&
    (target.agentId !== admission.agentId ||
      target.sessionId !== admission.sessionId ||
      target.sessionKey !== admission.sessionKey)
  ) {
    throw new SessionTranscriptReadFenceError(
      "Current-turn transcript admission belongs to a different transcript target",
    );
  }
  return runWithSessionTranscriptReadFence(admission, read);
}

export function resolveSessionTranscriptReadFence(session: {
  agentId: string;
  sessionId: string;
}): UserTurnTranscriptAdmissionReceipt | undefined {
  const receipt = transcriptReadFenceStorage.getStore();
  return receipt?.agentId === session.agentId && receipt.sessionId === session.sessionId
    ? receipt
    : undefined;
}

export function resolveSqliteSessionTranscriptReadFence(params: {
  database: Pick<OpenClawAgentDatabase, "db" | "path">;
  agentId: string;
  sessionId: string;
  sessionKey?: string;
}): SessionTranscriptReadFence | undefined {
  const receipt = resolveSessionTranscriptReadFence(params);
  if (!receipt) {
    return undefined;
  }
  if (receipt.role !== "user") {
    throw new SessionTranscriptReadFenceError(
      `Current-turn transcript admission is not a user message: ${receipt.entryId}`,
    );
  }
  if (!isSameTranscriptStore(params.database.path, receipt.storePath)) {
    throw new SessionTranscriptReadFenceError(
      "Current-turn transcript admission belongs to a different transcript store",
    );
  }
  if (params.sessionKey !== undefined && params.sessionKey !== receipt.sessionKey) {
    throw new SessionTranscriptReadFenceError(
      "Current-turn transcript admission belongs to a different session key",
    );
  }
  const db = getNodeSqliteKysely<
    Pick<
      DB,
      | "transcript_event_identities"
      | "session_transcript_active_events"
      | "transcript_events"
      | "transcript_rewrite_watermarks"
    >
  >(params.database.db);
  const boundary = executeSqliteQueryTakeFirstSync(
    params.database.db,
    db
      .selectFrom("transcript_event_identities as identity")
      .innerJoin("session_transcript_active_events as active", (join) =>
        join
          .onRef("active.session_id", "=", "identity.session_id")
          .onRef("active.event_seq", "=", "identity.seq"),
      )
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "identity.session_id")
          .onRef("event.seq", "=", "identity.seq"),
      )
      .innerJoin("transcript_rewrite_watermarks as rewrite", (join) =>
        join.onRef("rewrite.session_id", "=", "identity.session_id"),
      )
      .select([
        "identity.seq",
        "identity.parent_id",
        "active.message_position",
        "rewrite.generation",
        /* kysely-allow-raw: validate the admission role without acquiring its private payload. */
        sql<string>`json_extract(${transcriptEventNavigationSql("event")}, '$.type')`.as(
          "event_type",
        ),
        /* kysely-allow-raw: admission validation needs the exact role, not the message body. */
        sql<string>`json_extract(${transcriptEventNavigationSql("event")}, '$.message.role')`.as(
          "message_role",
        ),
      ])
      .where("identity.session_id", "=", params.sessionId)
      .where("identity.event_id", "=", receipt.entryId)
      .limit(1),
  );
  if (boundary?.message_position === null || boundary?.message_position === undefined) {
    throw new SessionTranscriptReadFenceError(
      `Current-turn transcript admission is no longer a visible message: ${receipt.entryId}`,
    );
  }
  if (
    boundary.generation !== receipt.generation ||
    boundary.seq !== receipt.rawSeq ||
    boundary.parent_id !== receipt.effectiveParentId ||
    boundary.message_position !== receipt.activeMessagePosition
  ) {
    // These are observed boundary facts, not a replacement admission or historical cause.
    const writer = getOwnedSessionTranscriptWriterFence({ sessionKey: receipt.sessionKey });
    log.warn("Current-turn transcript admission identity mismatch", {
      operation: "validate-current-turn-transcript-read",
      reason: "admission_identity_changed",
      transcriptScopeHash: identityHash(receipt.sessionId),
      entryHash: identityHash(receipt.entryId),
      logicalTurnHash: identityHash(receipt.logicalTurnId),
      writerRunHash: writer ? identityHash(writer.expectedWriterRunId) : null,
      generationChanged: boundary.generation !== receipt.generation,
      rawSeqChanged: boundary.seq !== receipt.rawSeq,
      parentChanged: boundary.parent_id !== receipt.effectiveParentId,
      activeMessagePositionChanged: boundary.message_position !== receipt.activeMessagePosition,
      expectedGenerationHash: identityHash(receipt.generation),
      currentGenerationHash: identityHash(boundary.generation),
      expectedRawSeq: receipt.rawSeq,
      currentRawSeq: boundary.seq,
      expectedParentHash: identityHash(receipt.effectiveParentId),
      currentParentHash: identityHash(boundary.parent_id),
      expectedActiveMessagePosition: receipt.activeMessagePosition,
      currentActiveMessagePosition: boundary.message_position,
    });
    throw new SessionTranscriptReadFenceError(
      `Current-turn transcript admission identity changed: ${receipt.entryId}`,
    );
  }
  if (boundary.event_type !== "message" || boundary.message_role !== "user") {
    throw new SessionTranscriptReadFenceError(
      `Current-turn transcript admission is not a user message: ${receipt.entryId}`,
    );
  }
  return {
    admission: receipt,
    beforeActiveMessagePosition: boundary.message_position,
    beforeRawSeq: boundary.seq,
  };
}
