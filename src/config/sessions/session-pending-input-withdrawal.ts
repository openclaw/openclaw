import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import {
  prepareSqliteScope,
  resolveSqliteScope,
  resolveSqliteWriteAdmissionScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import type { SessionPendingInputWithdrawal } from "./session-pending-input-withdrawal.worker.js";
import { captureSessionStoreReadTarget } from "./session-store-read-target.js";
import {
  settleSessionWorkerReceipt,
  type SessionWorkerReceiptAdmission,
} from "./session-worker-receipt.js";

function readWithdrawalResult(
  receipt: unknown,
  input: SessionPendingInputWithdrawal,
): boolean | undefined {
  return isRecord(receipt) &&
    receipt.kind === "session-pending-input-withdrawal" &&
    receipt.sessionKey === input.sessionKey &&
    receipt.sessionId === input.sessionId &&
    receipt.runId === input.runId &&
    typeof receipt.withdrawn === "boolean"
    ? receipt.withdrawn
    : undefined;
}

/** The caller retains live cancellation authority until withdrawal commits. */
export async function discardSessionPendingInput(
  scope: SessionAccessScope & { agentId: string; sessionId: string },
  runId: string,
  assertCurrent: () => void,
): Promise<boolean> {
  assertCurrent();
  if (getSessionActorStorageBinding(scope)) {
    throw new Error(
      "Queued input removal is unavailable for incognito chats; use Stop to cancel execution",
    );
  }
  const env = cloneEnvWithPlatformSemantics(scope.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const target = { ...scope, env };
  const logical = resolveSqliteScope({ ...target, storePath: undefined });
  const storePath =
    logical.path ?? target.storePath ?? resolveOpenClawAgentSqlitePath(toDatabaseOptions(logical));
  const input: SessionPendingInputWithdrawal = {
    sessionKey: logical.sessionKey,
    sessionId: target.sessionId,
    runId,
  };
  if (isIncognitoOpenClawAgentSqlitePath(storePath, toDatabaseOptions(logical))) {
    throw new Error(
      "Queued input removal is unavailable for incognito chats; use Stop to cancel execution",
    );
  }
  const captured = captureSessionStoreReadTarget(
    target,
    "Pending input withdrawal changed its captured database owner",
  );
  const writeAdmission = resolveSqliteWriteAdmissionScope(target);
  const withdraw = async () => {
    const resolved = await prepareSqliteScope(target);
    assertCurrent();
    const { options, identity, assertCurrent: assertSourceCurrent } = captured.resolve(resolved);
    if (!identity.key.startsWith("file:")) {
      return false;
    }
    const assertHeld = () => {
      assertSourceCurrent();
      assertCurrent();
    };
    assertHeld();
    let admitted: SessionWorkerReceiptAdmission | undefined;
    return withSessionEntryWorker(
      options,
      undefined,
      assertHeld,
      async (execution, source) => {
        const result = await execution.runExisting(source, (worker) =>
          settleSessionWorkerReceipt(
            () => worker.execute({ type: "session.pendingInputs.withdraw", input }),
            () => admitted,
            (facts) => readWithdrawalResult(facts, input),
            "Pending input withdrawal has no confirmed native completion and commit receipt",
          ),
        );
        return result ?? false;
      },
      (admission, retained, facts) => {
        if (!isRecord(facts) || readWithdrawalResult(facts.publication, input) === undefined) {
          throw new Error("Pending input withdrawal commit omitted its exact receipt");
        }
        admitted = { admission, retained };
      },
    );
  };
  return writeAdmission
    ? runOpenClawAgentWriteAdmission(toDatabaseOptions(writeAdmission), withdraw, true)
    : withdraw();
}
