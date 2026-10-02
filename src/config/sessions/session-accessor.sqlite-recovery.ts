import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import {
  retainSessionEntryWorkerPublication,
  type SessionEntryReplacementPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import type {
  RestartTombstoneRecoveryParams,
  RestartTombstoneRecoveryResult,
} from "./session-accessor.sqlite-recovery.types.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import {
  captureLifecycleDatabaseScope,
  prepareSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";

export type { RestartTombstoneRecoveryResult } from "./session-accessor.sqlite-recovery.types.js";

/** Clone and publish through the canonical worker while retaining the caller's live authority. */
export async function recoverSessionEntryFromRestartTombstone(
  params: RestartTombstoneRecoveryParams,
): Promise<RestartTombstoneRecoveryResult> {
  const { commitGuard, storePath, ...values } = params;
  const input = structuredClone(values);
  const scope = captureLifecycleDatabaseScope(
    await prepareSqliteScope({
      agentId: input.agentId,
      sessionKey: "",
      storePath,
      env: { ...process.env },
    }),
  );
  const assertCurrent = () => commitGuard?.();
  assertCurrent();
  const options = { ...toDatabaseOptions(scope), path: scope.path };
  let publication: ReturnType<typeof retainSessionEntryWorkerPublication> | undefined;
  let databaseIdentity: string | undefined;
  let admitted:
    | { admission: SqliteWorkerOperationAdmission; retained: RetainedWorkerTransactionAdmission }
    | undefined;
  return await withSessionEntryWorker(
    options,
    undefined,
    assertCurrent,
    async (execution, source) => {
      const result = await execution.runExisting(source, async (worker) => {
        databaseIdentity = execution.fileIdentity?.physicalIdentity;
        if (!databaseIdentity) {
          throw new Error("Session recovery lost its admitted database identity");
        }
        publication = retainSessionEntryWorkerPublication({
          agentId: scope.agentId,
          storePath: scope.path,
          databaseIdentity,
        });
        const outcome = await worker.execute({ type: "session.restart.recover", input }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        if (admitted) {
          await admitted.retained.settled;
          const facts = admitted.admission.committed?.facts;
          let receipt = outcome.ok ? outcome.value.publication : undefined;
          if (isRecord(facts) && facts.kind === "session-entry-replacements") {
            // SAFETY: The paired recovery kernel owns this retained command's receipt.
            receipt = facts as SessionEntryReplacementPublication;
          }
          const unchanged =
            (outcome.ok && outcome.value.result.status !== "created") ||
            (isRecord(facts) && facts.kind === "session-restart-recovery-unchanged");
          const unknown =
            admitted.admission.settlement?.kind !== "completed" || (!receipt && !unchanged);
          const published = publication.settle(receipt, unknown);
          if (published) {
            publishCommittedSessionIdentity(
              scope.agentId,
              databaseIdentity,
              published.previous,
              published.current,
            );
          }
          if (unknown) {
            const error = new SqliteWorkerError(
              "Session recovery has no confirmed native completion and commit receipt",
              "outcome-unknown",
            );
            error.cause = outcome.ok ? undefined : outcome.error;
            throw error;
          }
        }
        if (!outcome.ok) {
          throw outcome.error;
        }
        return outcome.value.result;
      });
      return result ?? { status: "conflict", reason: "not-tombstoned" };
    },
    (admission, retained, facts) => {
      admitted = { admission, retained };
      if (!isRecord(facts) || facts.publication === undefined) {
        return;
      }
      const receipt = facts.publication;
      if (
        !isRecord(receipt) ||
        receipt.kind !== "session-entry-replacements" ||
        !Array.isArray(receipt.changedKeys) ||
        !receipt.changedKeys.every((key): key is string => typeof key === "string") ||
        !publication
      ) {
        throw new Error("Session recovery commit omitted its publication keys");
      }
      publication.begin(receipt.changedKeys, []);
    },
  );
}
