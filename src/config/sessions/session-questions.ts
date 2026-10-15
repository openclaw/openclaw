import { randomUUID } from "node:crypto";
import type { DurableQuestionSessionBinding } from "../../gateway/question-session-access.types.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { executeOpenClawAgentWorkerPublication } from "../../state/openclaw-agent-worker-store.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { prepareSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { runSessionEntryWorkerOperation } from "./session-entry-patch.js";
import { SessionQuestionCustodyRetiredError } from "./session-questions-custody-error.js";
import type {
  DurableQuestion,
  SessionQuestionOperation,
  SessionQuestionResult,
} from "./session-questions.types.js";
import type {
  SessionQuestionCandidate,
  SessionQuestionOperations,
} from "./session-questions.worker.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

export type { DurableQuestion } from "./session-questions.types.js";

/** Host authority stays live through native transaction and commit admission. */
export async function executeSessionQuestionOperation(
  options: SessionAccessScope & { assertCurrent: () => void },
  input: SessionQuestionOperation,
): Promise<SessionQuestionResult> {
  if (isIncognitoSessionKey(options.sessionKey)) {
    throw new Error("Incognito questions remain transient and cannot acquire durable custody.");
  }
  options.assertCurrent();
  const target = await prepareSqliteScope(options);
  options.assertCurrent();
  const database = {
    ...toDatabaseOptions(target),
    path: target.path ?? resolveOpenClawAgentSqlitePath(toDatabaseOptions(target)),
    env: Object.freeze({ ...(target.env ?? process.env) }),
  };
  if (
    input.kind === "register" ||
    input.kind === "settle" ||
    input.kind === "claim" ||
    input.kind === "finish" ||
    input.kind === "block"
  ) {
    const binding =
      input.kind === "register"
        ? input.question.sessionBinding
        : input.expectedQuestion?.sessionBinding;
    if (!binding) {
      throw new SessionQuestionCustodyRetiredError(
        "Captured durable question custody is required.",
      );
    }
    if (
      target.agentId !== binding.agentId ||
      target.sessionKey !== binding.sessionKey ||
      database.path !== binding.databasePath ||
      options.storePath !== binding.storePath
    ) {
      throw new SessionQuestionCustodyRetiredError(
        "Captured durable question storage route was retired.",
      );
    }
  }
  if (input.kind === "get" || input.kind === "list") {
    return withSessionHistoryWorkerDatabase(database, async (owner) => {
      const result = await owner.readQuestions({ operation: input, env: database.env });
      options.assertCurrent();
      owner.assertCurrent();
      return result;
    });
  }
  const execution = captureOpenClawAgentDatabaseExecution(database);
  const request = structuredClone(input);
  return runSessionEntryWorkerOperation<SessionQuestionCandidate, SessionQuestionResult>({
    database,
    retainedExecution: execution,
    releaseSource: () => execution.release(),
    agentId: target.agentId,
    candidateKind: "session-question",
    assertCurrent: options.assertCurrent,
    run: (worker, commit) =>
      commit(() =>
        executeOpenClawAgentWorkerPublication<
          SessionQuestionOperations,
          "session.question.operate"
        >(worker, {
          id: randomUUID(),
          moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionQuestionOperations)
            .href,
          input: { agentId: target.agentId },
          command: { type: "session.question.operate", input: request },
        }),
      ),
    onCommitted: (candidate) => candidate.result,
  });
}

/** Gateway custody reconciliation reads committed facts without borrowing caller authority. */
export async function readSessionQuestionCustody(
  binding: DurableQuestionSessionBinding,
  id: string,
  assertGatewayCurrent: () => void,
): Promise<DurableQuestion | undefined> {
  assertGatewayCurrent();
  const captured = structuredClone(binding);
  if (isIncognitoSessionKey(captured.sessionKey)) {
    throw new Error("Incognito questions do not have durable custody.");
  }
  const database = {
    agentId: captured.agentId,
    path: captured.databasePath,
    env: Object.freeze({ ...process.env }),
  };
  return withSessionHistoryWorkerDatabase(database, async (owner) => {
    assertGatewayCurrent();
    const result = await owner.readQuestions({
      operation: { kind: "get", id },
      env: database.env,
      custodyBinding: captured,
    });
    assertGatewayCurrent();
    owner.assertCurrent();
    if (Array.isArray(result)) {
      throw new Error("Durable question custody returned a collection instead of one receipt.");
    }
    return result;
  });
}
