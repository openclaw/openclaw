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
  RetiredPendingInputDismissal,
  RetiredPendingInputDismissalOutcome,
} from "./session-pending-input-dismissal.worker.js";
import { captureSessionStoreReadTarget } from "./session-store-read-target.js";
import {
  settleSessionWorkerReceipt,
  type SessionWorkerReceiptAdmission,
} from "./session-worker-receipt.js";

class RetiredPendingInputOwnedError extends Error {
  constructor(readonly inputIds: string[]) {
    super("Pending input is still settling; retry after its turn ends");
  }
}

function readDismissalOutcome(
  receipt: unknown,
  input: RetiredPendingInputDismissal,
): RetiredPendingInputDismissalOutcome | undefined {
  if (
    !isRecord(receipt) ||
    receipt.kind !== "session-retired-pending-input-dismissal" ||
    receipt.sessionKey !== input.sessionKey ||
    receipt.sessionId !== input.sessionId ||
    !isRecord(receipt.outcome)
  ) {
    return undefined;
  }
  // SAFETY: This admission retains only this exact kernel's committed receipt.
  return receipt.outcome as RetiredPendingInputDismissalOutcome;
}

function readCandidateIds(
  request: unknown,
  input: RetiredPendingInputDismissal,
): string[] | undefined {
  const facts = isRecord(request) ? request.publication : undefined;
  if (!isRecord(facts) || facts.kind !== "retired-pending-input-dismissal-candidates") {
    return undefined;
  }
  if (
    facts.sessionKey !== input.sessionKey ||
    facts.sessionId !== input.sessionId ||
    !Array.isArray(facts.inputIds)
  ) {
    throw new Error("Retired pending input dismissal omitted its exact candidates");
  }
  return facts.inputIds.filter((id): id is string => typeof id === "string");
}

/** Hide interrupted or cancelled custody; queued and live-owned inputs are never touched. */
export async function dismissRetiredSessionPendingInputs(
  scope: SessionAccessScope & { agentId: string; sessionId: string },
  inputIds: readonly string[],
  assertCurrent: () => void,
): Promise<RetiredPendingInputDismissalOutcome> {
  assertCurrent();
  if (captureSessionActorStorageOwner(scope, { assertCurrent, authorize: assertCurrent })) {
    throw new Error("Dismissing retained inputs is unavailable for incognito chats");
  }
  const env = cloneEnvWithPlatformSemantics(scope.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const target = { ...scope, env };
  const logical = resolveSqliteScope({ ...target, storePath: undefined });
  const input: RetiredPendingInputDismissal = {
    sessionKey: logical.sessionKey,
    sessionId: target.sessionId,
    inputIds: [...inputIds],
  };
  const captured = captureSessionStoreReadTarget(
    target,
    "Retired pending input dismissal changed its captured database owner",
  );
  const writeAdmission = resolveSqliteWriteAdmissionScope(target);
  const dismiss = async (): Promise<RetiredPendingInputDismissalOutcome> => {
    const resolved = await prepareSqliteScope(target);
    assertCurrent();
    const { options, identity, assertCurrent: assertSourceCurrent } = captured.resolve(resolved);
    if (!identity.key.startsWith("file:")) {
      return { kind: "dismissed", inputIds: [], runIds: [], missingIds: [...inputIds] };
    }
    const assertHeld = () => {
      assertSourceCurrent();
      assertCurrent();
    };
    assertHeld();
    let admitted: SessionWorkerReceiptAdmission | undefined;
    let candidatesChecked = false;
    try {
      const result = await withSessionEntryWorker(
        options,
        undefined,
        assertHeld,
        (execution, source) =>
          execution.runExisting(source, (worker) =>
            settleSessionWorkerReceipt(
              () => worker.execute({ type: "session.pendingInputs.dismissRetired", input }),
              () => admitted,
              (facts) => readDismissalOutcome(facts, input),
              "Retired pending input dismissal has no confirmed native completion and commit receipt",
            ),
          ),
        (admission, retained, facts) => {
          if (
            !candidatesChecked ||
            !isRecord(facts) ||
            readDismissalOutcome(facts.publication, input) === undefined
          ) {
            throw new Error("Retired pending input dismissal commit omitted its exact receipt");
          }
          admitted = { admission, retained };
        },
        undefined,
        undefined,
        undefined,
        (facts) => {
          const candidates = readCandidateIds(facts, input);
          if (!candidates) {
            return;
          }
          candidatesChecked = true;
          const owned = candidates.filter((id) =>
            hasRegisteredSessionPendingInputOwner(identity.canonicalPath, {
              input_id: id,
              session_key: input.sessionKey,
              session_id: input.sessionId,
            }),
          );
          if (owned.length) {
            throw new RetiredPendingInputOwnedError(owned);
          }
        },
      );
      if (!result) {
        throw new Error("Retired pending input dismissal lost its existing database");
      }
      return result;
    } catch (error) {
      if (error instanceof RetiredPendingInputOwnedError) {
        return { kind: "active", inputIds: error.inputIds };
      }
      throw error;
    }
  };
  return writeAdmission
    ? runOpenClawAgentWriteAdmission(toDatabaseOptions(writeAdmission), dismiss, true)
    : dismiss();
}
