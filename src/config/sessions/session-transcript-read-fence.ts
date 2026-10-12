import { AsyncLocalStorage } from "node:async_hooks";
import {
  getUserTurnTranscriptAdmissionOwner,
  readPendingUserTurnTranscriptAdmission,
} from "../../sessions/user-turn-transcript-admission.js";
import type {
  UserTurnTranscriptAdmissionReceipt,
  UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.types.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";

export { SessionTranscriptReadFenceError };

const transcriptReadFenceStorage = new AsyncLocalStorage<UserTurnTranscriptAdmissionReceipt>();

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

export function captureSessionTranscriptQuestionAnswers(
  database: Pick<OpenClawAgentDatabase, "path">,
  sessionId: string,
  admittedUserId?: string,
) {
  const scope = questionAnswerStorage.getStore();
  const answers = [...(scope?.inputs.values() ?? [])].filter(
    (input) =>
      isSameTranscriptStore(input.storePath, database.path) && input.sessionId === sessionId,
  );
  if (!scope || answers.length === 0) {
    return undefined;
  }
  const assertCurrent = () => {
    scope.assertActive();
    const creator = scope.recorder && getUserTurnTranscriptAdmissionOwner(scope.recorder);
    const original = creator?.receipt();
    if (
      !original ||
      creator?.blocked() ||
      !answers.every(
        (input) =>
          original.agentId === input.agentId &&
          original.sessionId === input.sessionId &&
          original.sessionKey === input.sessionKey &&
          isSameTranscriptStore(original.storePath, input.storePath) &&
          original.generation === input.generation &&
          (admittedUserId === undefined || original.entryId === admittedUserId),
      )
    ) {
      throw new SqliteTranscriptMutationConflictError(sessionId);
    }
  };
  assertCurrent();
  return { answers, assertCurrent };
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
  database: Pick<OpenClawAgentDatabase, "path">;
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
  // The admission owner publishes these committed bounds. Context consumers
  // validate their accepted snapshot; external SQLite writers are unsupported.
  return {
    admission: receipt,
    beforeActiveMessagePosition: receipt.activeMessagePosition,
    beforeRawSeq: receipt.rawSeq,
  };
}
