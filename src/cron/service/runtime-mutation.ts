import { randomUUID } from "node:crypto";
import { deserialize } from "node:v8";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import type {
  SqliteWorkerNativeSettlementOwner,
  SqliteWorkerOperationSettlement,
} from "../../infra/sqlite-worker-operation-settlement.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type { CronRuntimeMutationContracts } from "../store/runtime-mutation.types.js";
import type {
  CronRuntimeMutationType,
  CronRuntimeWorkerOperations,
} from "../store/runtime-worker.types.js";

/** One settlement owner serves typed cron mutations; callbacks and database handles stay local. */
export async function runCronRuntimeMutation<Type extends CronRuntimeMutationType>(params: {
  context: OpenClawStateWorkerContext;
  type: Type;
  input: CronRuntimeMutationContracts[Type]["input"];
  assertCurrent: () => void;
  prepare: (facts: CronRuntimeMutationContracts[Type]["facts"]) => {
    value: CronRuntimeMutationContracts[Type]["preparation"];
    assertCurrent: () => void;
  };
  publish: (outcome: CronRuntimeMutationContracts[Type]["outcome"]) => void;
  onSettled?: (outcome: "committed" | "not-committed" | "unknown") => void;
}): Promise<void> {
  const nonce = randomUUID();
  let settlement: Promise<SqliteWorkerOperationSettlement> | undefined;
  let native: SqliteWorkerNativeSettlementOwner | undefined;
  let bytes: Uint8Array | undefined;
  let published = false;
  const assertCurrent = () => {
    params.context.admission.assertCurrent();
    params.assertCurrent();
  };
  const publishCommitted = () => {
    const committed = native?.committed?.facts;
    if (published || !isRecord(committed) || committed.nonce !== nonce) {
      return;
    }
    if (!bytes) {
      throw new Error("Committed cron mutation lost its retained outcome");
    }
    // SAFETY: this command's private worker retained these bytes before its matching native commit.
    const outcome = deserialize(bytes) as CronRuntimeMutationContracts[Type]["outcome"];
    published = true;
    bytes = undefined;
    params.publish(outcome);
  };
  try {
    await runOpenClawStateWorkerOperation(
      params.context,
      async (scope) => {
        try {
          const command = {
            type: params.type,
            input: { ...params.input, nonce },
            // SAFETY: Type selects both the command and its input from the same contract map.
          } as SqliteWorkerCommand<CronRuntimeWorkerOperations>;
          const result = await scope.execute(command);
          if (result.nonce !== nonce) {
            throw new Error("Cron mutation returned a different operation nonce");
          }
        } finally {
          await settlement;
          publishCommitted();
        }
      },
      {
        assertCurrent,
        createAdmission(retained) {
          settlement = retained.settled;
          let phase: "transaction" | "commit" | "settling" = "transaction";
          let preparation: ReturnType<typeof params.prepare> | undefined;
          const admission = createSqliteWorkerOperationAdmission((request, grant) => {
            const facts = request.facts;
            const port =
              isRecord(facts) && facts.preparationPort instanceof MessagePort
                ? facts.preparationPort
                : undefined;
            try {
              assertCurrent();
              if (!isRecord(facts) || facts.nonce !== nonce || request.stage !== phase) {
                throw new Error("Cron mutation differs from its retained transaction owner");
              }
              if (request.stage === "transaction") {
                if (!port) {
                  throw new Error("Cron mutation has no policy preparation port");
                }
                preparation = params.prepare(
                  // SAFETY: this private worker supplies the selected command's typed transaction facts.
                  facts.preparation as CronRuntimeMutationContracts[Type]["facts"],
                );
                port.postMessage(preparation.value, []);
                phase = "commit";
              } else {
                if (!(facts.bytes instanceof Uint8Array) || !preparation) {
                  throw new Error("Cron mutation has no prepared outcome");
                }
                preparation.assertCurrent();
                bytes = facts.bytes;
                phase = "settling";
              }
            } finally {
              port?.close();
            }
            if (!grant()) {
              throw new Error("Cron mutation admission expired");
            }
          });
          native = admission;
          return { nativeLocations: [params.context.admission.databasePath], admission };
        },
      },
    );
    if (!published) {
      throw new Error("Cron mutation did not publish a committed outcome");
    }
  } finally {
    const settled = await settlement;
    try {
      publishCommitted();
    } finally {
      params.onSettled?.(
        native?.committed
          ? "committed"
          : settled === undefined ||
              settled.kind === "not-entered" ||
              native?.settlement?.kind === "completed"
            ? "not-committed"
            : "unknown",
      );
      bytes = undefined;
    }
  }
}
