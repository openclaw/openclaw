import path from "node:path";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  assertSessionGoalOperationTime,
  readSessionGoalOperationInDatabase,
  SessionGoalOperationError,
} from "./goals-operations.js";
import type {
  SessionGoalOperationLookup,
  SessionGoalOperationResult,
} from "./goals-operations.types.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  prepareSqliteScope,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  captureIncognitoSessionOperation,
  captureIncognitoSessionSource,
} from "./session-incognito-binding.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/** Durable ingress receipts precede transient dedupe and busy-session refusals. */
export async function lookupSessionGoalOperation(
  options: SessionAccessScope & SessionGoalOperationLookup,
): Promise<SessionGoalOperationResult | undefined> {
  const captured = {
    ...options,
    ...(options.storePath ? { storePath: path.resolve(options.storePath) } : {}),
    operation: { ...options.operation },
    env: captureSessionTranscriptStorageEnvironment(options.env ?? process.env),
  };
  assertSessionGoalOperationTime(captured.operation, Date.now());
  const source = captureIncognitoSessionSource(options);
  if (source && "kind" in source) {
    source.assertCurrent();
    return undefined;
  }
  const incognito = captureIncognitoSessionOperation(options);
  if (incognito) {
    const target = resolveSqliteScope({
      ...options,
      agentId: incognito.actor.agentId,
      storePath: incognito.actor.path,
    });
    return incognito.actor.sessions.transcript(
      incognito.authority,
      {
        type: "session.goalReceipt.read",
        input: {
          sessionKey: target.sessionKey,
          sessionId: captured.expectedSessionId,
          expectedSessionId: captured.expectedSessionId,
          operation: captured.operation,
          fence: {},
        },
      },
      incognito.admissionSignal,
    );
  }
  if (isIncognitoSessionKey(captured.sessionKey)) {
    // Process-held incognito databases cannot be reopened in a worker.
    const target = resolveSqliteScope(captured);
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        readSessionGoalOperationInDatabase(database, {
          ...captured,
          sessionKey: target.sessionKey,
        }),
      toDatabaseOptions(target),
    );
    return result.found ? result.value : undefined;
  }
  const context = captureOpenClawStateWorkerContext({ env: captured.env });
  const assertCurrent = () => {
    context.maintenanceScope?.assertAdmission();
    context.admission.assertCurrent();
  };
  const target = await prepareSqliteScope(captured);
  assertCurrent();
  return withSessionHistoryWorkerDatabase(toDatabaseOptions(target), async (owner) => {
    const result = await owner.readGoalOperationReceipt({
      sessionKey: target.sessionKey,
      expectedSessionId: captured.expectedSessionId,
      operation: captured.operation,
      env: captured.env,
    });
    assertCurrent();
    owner.assertCurrent();
    if ("error" in result) {
      throw new SessionGoalOperationError(result.error.code, result.error.message);
    }
    return result.receipt;
  });
}
