import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
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
import type { SessionPendingInputWithdrawal } from "./session-pending-input-withdrawal.worker.js";
import { assertSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";

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
  const candidates = captureSessionStoreReadCandidates(storePath);
  const identities = new Map(
    candidates
      .filter((candidate) => !candidate.scope)
      .map((candidate) => {
        const identity = readDatabasePathIdentitySync(candidate.path);
        return [identity.canonicalPath, identity] as const;
      }),
  );
  const writeAdmission = resolveSqliteWriteAdmissionScope(target);
  const withdraw = async () => {
    const resolved = await prepareSqliteScope(target);
    assertCurrent();
    const options = toDatabaseOptions(resolved);
    const path = resolveOpenClawAgentSqlitePath(options);
    const identity = identities.get(assertSessionStoreReadCandidate(path, candidates));
    if (!identity) {
      throw new Error("Pending input withdrawal changed its captured database owner");
    }
    if (!identity.key.startsWith("file:")) {
      return false;
    }
    const assertHeld = () => {
      assertSessionStoreReadCandidate(path, candidates);
      assertExistingDatabaseIdentity(path, identity.key, identity.birthtime);
      assertCurrent();
    };
    assertHeld();
    let admitted:
      | { admission: SqliteWorkerOperationAdmission; retained: RetainedWorkerTransactionAdmission }
      | undefined;
    return withSessionEntryWorker(
      { ...options, path },
      undefined,
      assertHeld,
      async (execution, source) => {
        const result = await execution.runExisting(source, async (worker) => {
          const outcome = await worker
            .execute({ type: "session.pendingInputs.withdraw", input })
            .then(
              () => ({ ok: true as const }),
              (error: unknown) => ({ ok: false as const, error }),
            );
          if (admitted) {
            // Native commitment survives lost result delivery; join it before releasing FIFO custody.
            await admitted.retained.settled;
            const withdrawn = readWithdrawalResult(admitted.admission.committed?.facts, input);
            if (admitted.admission.settlement?.kind === "completed" && withdrawn !== undefined) {
              return withdrawn;
            }
          }
          if (!outcome.ok) {
            throw outcome.error;
          }
          throw new SqliteWorkerError(
            "Pending input withdrawal has no confirmed native completion and commit receipt",
            "outcome-unknown",
          );
        });
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
