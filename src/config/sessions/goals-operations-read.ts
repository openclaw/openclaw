import path from "node:path";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { assertSessionGoalOperationTime } from "./goals-operation-policy.js";
import { SessionGoalOperationError } from "./goals-operations.js";
import type {
  SessionGoalOperationLookup,
  SessionGoalOperationResult,
} from "./goals-operations.types.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { prepareSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
} from "./session-actor-storage-binding.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/** Durable ingress receipts precede transient dedupe and busy-session refusals. */
export async function lookupSessionGoalOperation(
  options: SessionAccessScope & SessionGoalOperationLookup,
): Promise<SessionGoalOperationResult | undefined> {
  assertSessionGoalOperationTime(options.operation, Date.now());
  const authority = { assertCurrent() {}, authorize() {} };
  const memory = captureSessionActorStorageOwner(options, authority);
  if (memory) {
    return withSessionActorStorage(
      options,
      {
        lifetime: { assertCurrent() {}, assertReadable() {} },
        authority: memory.authority,
      },
      (binding) =>
        binding.actor.storage!.read(
          {
            type: "session.goal.receipt",
            input: {
              sessionKey: binding.actor.target.sessionKey,
              expectedSessionId: options.expectedSessionId,
              operation: options.operation,
            },
          },
          binding.authority,
        ),
    );
  }
  const captured = {
    ...options,
    ...(options.storePath ? { storePath: path.resolve(options.storePath) } : {}),
    operation: { ...options.operation },
    env: captureSessionTranscriptStorageEnvironment(options.env ?? process.env),
  };
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
