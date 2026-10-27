import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { hasRegisteredSessionPendingInputOwner } from "./session-accessor.sqlite-pending-inputs.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import {
  prepareSqliteScope,
  resolveSqliteScope,
  resolveSqliteWriteAdmissionScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import type {
  RetiredPendingInputDismissalOutcome,
  SessionPendingInputWithdrawal,
  SessionPendingInputWithdrawalResult,
} from "./session-pending-input-withdrawal.worker.js";
import { captureSessionStoreReadTarget } from "./session-store-read-target.js";
import {
  settleSessionWorkerReceipt,
  type SessionWorkerReceiptAdmission,
} from "./session-worker-receipt.js";

type WithdrawalScope = SessionAccessScope & { agentId: string; sessionId: string };
type WithdrawalSelection = { runId: string } | { inputIds: readonly string[] };

class PendingInputOwnedError extends Error {
  constructor(readonly inputIds: string[]) {
    super("Pending input is still settling; retry after its turn ends");
  }
}

function readWithdrawalResult(
  receipt: unknown,
  input: SessionPendingInputWithdrawal,
): SessionPendingInputWithdrawalResult | undefined {
  if (
    !isRecord(receipt) ||
    receipt.kind !== "session-pending-input-withdrawal" ||
    receipt.sessionKey !== input.sessionKey ||
    receipt.sessionId !== input.sessionId ||
    ("runId" in input
      ? receipt.runId !== input.runId || typeof receipt.outcome !== "boolean"
      : !Array.isArray(receipt.inputIds) ||
        receipt.inputIds.length !== input.inputIds.length ||
        JSON.stringify(receipt.inputIds) !== JSON.stringify(input.inputIds) ||
        !isRecord(receipt.outcome))
  ) {
    return undefined;
  }
  // SAFETY: This admission retains only this exact kernel's committed receipt.
  return receipt.outcome as SessionPendingInputWithdrawalResult;
}

/** The caller retains live cancellation authority until withdrawal commits. */
async function withdrawSessionPendingInputs(
  scope: WithdrawalScope,
  selection: WithdrawalSelection,
  assertCurrent: () => void,
): Promise<SessionPendingInputWithdrawalResult> {
  assertCurrent();
  if (captureSessionActorStorageOwner(scope, { assertCurrent, authorize: assertCurrent })) {
    throw new Error(
      "Pending input removal is unavailable for incognito chats; use Stop to cancel execution",
    );
  }
  const env = cloneEnvWithPlatformSemantics(scope.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const target = { ...scope, env };
  const logical = resolveSqliteScope({ ...target, storePath: undefined });
  const input: SessionPendingInputWithdrawal = {
    sessionKey: logical.sessionKey,
    sessionId: target.sessionId,
    ...selection,
  };
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
      return "runId" in input
        ? false
        : { kind: "dismissed" as const, inputIds: [], runIds: [], missingIds: [...input.inputIds] };
    }
    const assertHeld = () => {
      assertSourceCurrent();
      assertCurrent();
    };
    assertHeld();
    let admitted: SessionWorkerReceiptAdmission | undefined;
    try {
      return await withSessionEntryWorker(
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
          if (result === undefined && "inputIds" in input) {
            throw new Error("Pending input withdrawal lost its existing database");
          }
          return result ?? false;
        },
        (admission, retained, facts) => {
          if (!isRecord(facts) || readWithdrawalResult(facts.publication, input) === undefined) {
            throw new Error("Pending input withdrawal commit omitted its exact receipt");
          }
          admitted = { admission, retained };
        },
        undefined,
        undefined,
        undefined,
        (request) => {
          const facts = isRecord(request) ? request.publication : undefined;
          if (
            !("inputIds" in input) ||
            !isRecord(facts) ||
            facts.kind !== "pending-input-withdrawal-candidates"
          ) {
            return;
          }
          if (!Array.isArray(facts.inputIds)) {
            throw new Error("Pending input withdrawal omitted its candidates");
          }
          const owned = facts.inputIds.filter(
            (id): id is string =>
              typeof id === "string" &&
              hasRegisteredSessionPendingInputOwner(identity.canonicalPath, {
                input_id: id,
                session_key: input.sessionKey,
                session_id: input.sessionId,
              }),
          );
          if (owned.length) {
            throw new PendingInputOwnedError(owned);
          }
        },
      );
    } catch (error) {
      if (error instanceof PendingInputOwnedError) {
        return { kind: "active" as const, inputIds: error.inputIds };
      }
      throw error;
    }
  };
  return writeAdmission
    ? runOpenClawAgentWriteAdmission(toDatabaseOptions(writeAdmission), withdraw, true)
    : withdraw();
}

export async function discardSessionPendingInput(
  scope: WithdrawalScope,
  runId: string,
  assertCurrent: () => void,
): Promise<boolean> {
  return (await withdrawSessionPendingInputs(scope, { runId }, assertCurrent)) === true;
}

/** Hide retired custody without deleting its content or replay fence. */
export async function dismissRetiredSessionPendingInputs(
  scope: WithdrawalScope,
  inputIds: readonly string[],
  assertCurrent: () => void,
): Promise<RetiredPendingInputDismissalOutcome> {
  const result = await withdrawSessionPendingInputs(scope, { inputIds }, assertCurrent);
  if (typeof result === "boolean") {
    throw new Error("Retired input withdrawal returned a queued-input result");
  }
  return result;
}
