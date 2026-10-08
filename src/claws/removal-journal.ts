import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { captureActiveCronJobAgentDeletion } from "../cron/active-jobs.js";
import { withCronReceiptAuthorityMutation } from "../cron/store/receipt-authority-owner.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type {
  SqliteWorkerNativeSettlementOwner,
  SqliteWorkerOperationSettlement,
} from "../infra/sqlite-worker-operation-settlement.js";
import { captureAgentDatabasePreparationDeletionForIdentity } from "../state/agent-database-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  clawRemovalJournalResultSchema,
  type ClawRemovalJournalWorkerInput,
} from "./removal-journal-contract.js";

/** Only the serving Cron owner publishes a journal mutation; native settlement precedes its reply. */
export async function mutateClawRemovalJournal(
  input: Omit<ClawRemovalJournalWorkerInput, "nonce">,
  assertRequestCurrent: () => void,
) {
  const context = captureOpenClawStateWorkerContext();
  const assertSourceCurrent = () => {
    context.admission.assertCurrent();
    if (!isDeepStrictEqual(context.admission.identity, input.request.sourceIdentity)) {
      throw new Error("Claw journal mutation no longer owns its original physical database.");
    }
  };
  assertSourceCurrent();
  const command = { ...structuredClone(input), nonce: randomUUID() };
  const cancel = captureActiveCronJobAgentDeletion(
    input.request.agentId,
    context.admission.identity.key,
  );
  const invalidatePreparation = captureAgentDatabasePreparationDeletionForIdentity(
    input.request.agentId,
    {
      databasePath: context.admission.databasePath,
      identityKey: context.admission.identity.key,
    },
  );
  return withCronReceiptAuthorityMutation(context, async (mutation) => {
    const assertCurrent = () => {
      assertSourceCurrent();
      mutation.assertCurrent();
      assertRequestCurrent();
    };
    let native: SqliteWorkerNativeSettlementOwner | undefined;
    let settlement: Promise<SqliteWorkerOperationSettlement> | undefined;
    let failure: unknown;
    try {
      await runOpenClawStateWorkerOperation(
        mutation.context,
        async (scope) => {
          const reply = await scope.execute({
            type: "clawProvenance.removalJournal",
            input: command,
          });
          if (reply.nonce !== command.nonce) {
            throw new Error("Claw journal mutation returned a different operation nonce");
          }
        },
        {
          assertCurrent,
          createAdmission(retained) {
            settlement = retained.settled;
            let phase: "transaction" | "commit" | "settling" = "transaction";
            const admission = createSqliteWorkerOperationAdmission((request, grant) => {
              assertCurrent();
              if (
                !isRecord(request.facts) ||
                request.facts.nonce !== command.nonce ||
                request.stage !== phase
              ) {
                throw new Error("Claw journal mutation lost its transaction owner");
              }
              if (!grant()) {
                throw new Error("Claw journal mutation admission expired");
              }
              phase = phase === "transaction" ? "commit" : "settling";
            }, mutation.attachment);
            native = admission;
            mutation.observe(admission, retained);
            return { admission, nativeLocations: [context.admission.databasePath] };
          },
        },
      );
    } catch (error) {
      failure = error;
    }
    const settled = await settlement;
    const facts = native?.committed?.facts;
    if (isRecord(facts) && facts.nonce === command.nonce) {
      const result = clawRemovalJournalResultSchema.parse({ ok: true, journal: facts.journal });
      if (input.request.phase === "begin") {
        invalidatePreparation();
        cancel();
      }
      return result;
    }
    if (
      native?.committed ||
      settled?.kind === "unknown" ||
      native?.settlement?.kind === "unknown"
    ) {
      throw new SqliteWorkerError(
        "Claw journal mutation has an unknown durable outcome; inspect claws status before retrying.",
        "outcome-unknown",
      );
    }
    return {
      ok: false as const,
      error: failure instanceof Error ? failure.message : "Claw journal mutation did not commit.",
    };
  });
}
