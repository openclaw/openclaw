import { randomUUID } from "node:crypto";
import { deserialize } from "node:v8";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { publishCronJobsStoreMutation } from "../cron/store.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type {
  SqliteWorkerNativeSettlementOwner,
  SqliteWorkerOperationSettlement,
} from "../infra/sqlite-worker-operation-settlement.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type {
  PortableHeartbeatMutation,
  PortableHeartbeatMutationResult,
} from "./portable-heartbeat-write.types.js";
import { cacheClawInstallSchemaVersion } from "./provenance-runtime-read.js";

export class ClawPortableMutationUncertainError extends Error {
  constructor(cause: unknown) {
    super(
      "Portable automation mutation has an uncertain durable outcome; retain the current installation and inspect Claw state before retrying.",
      { cause },
    );
    this.name = "ClawPortableMutationUncertainError";
  }
}

/** Retain the native commit outcome so a lost worker reply never authorizes compensation. */
export async function mutatePortableHeartbeat(
  mutation: PortableHeartbeatMutation,
  options: OpenClawStateDatabaseOptions & { assertCurrent?: () => void } = {},
): Promise<PortableHeartbeatMutationResult> {
  if (options.readOnly) {
    throw new Error("Portable automation mutation requires writable state.");
  }
  const input = { ...structuredClone(mutation), nonce: randomUUID() };
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const assertCurrent = () => {
    context.admission.assertCurrent();
    options.assertCurrent?.();
    context.admission.assertCurrent();
  };
  let native: SqliteWorkerNativeSettlementOwner | undefined;
  let settlement: Promise<SqliteWorkerOperationSettlement> | undefined;
  let bytes: Uint8Array | undefined;
  let failure: unknown;
  try {
    await runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        const reply = await scope.execute({ type: "clawProvenance.portableHeartbeat", input });
        if (reply.nonce !== input.nonce) {
          throw new Error("Portable automation mutation returned a different operation nonce");
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
              request.facts.nonce !== input.nonce ||
              request.stage !== phase
            ) {
              throw new Error("Portable automation mutation lost its transaction owner");
            }
            if (request.stage === "commit") {
              if (!(request.facts.bytes instanceof Uint8Array)) {
                throw new Error("Portable automation mutation lost its retained outcome");
              }
              bytes = request.facts.bytes;
            }
            if (!grant()) {
              throw new Error("Portable automation mutation admission expired");
            }
            phase = phase === "transaction" ? "commit" : "settling";
          });
          native = admission;
          return { admission, nativeLocations: [context.admission.databasePath] };
        },
      },
    );
  } catch (error) {
    failure = error;
  }
  const settled = await settlement;
  const committed = native?.committed?.facts;
  if (isRecord(committed) && committed.nonce === input.nonce && bytes) {
    let result: PortableHeartbeatMutationResult;
    try {
      // SAFETY: The selected private worker retained this typed outcome before its matching native commit.
      result = deserialize(bytes) as PortableHeartbeatMutationResult;
    } catch (error) {
      throw new ClawPortableMutationUncertainError(error);
    }
    let current = false;
    try {
      context.admission.assertCurrent();
      current = true;
    } catch {
      // A later database replacement must not receive the retired owner's cached facts.
    }
    try {
      publishCronJobsStoreMutation(result.state.storePath);
      if (current && result.installRecord) {
        cacheClawInstallSchemaVersion(
          result.installRecord.agentId,
          result.installRecord.schemaVersion,
          result.installRecord.agentConfigDigest,
          {
            path: context.admission.databasePath,
            env: context.environment,
          },
        );
      }
    } catch (error) {
      // A failed notification cannot authorize rollback of an already committed install.
      createSubsystemLogger("claws").warn(
        `Portable automation committed but publication failed: ${String(error)}. Inspect claws status and automations list.`,
      );
    }
    return result;
  }
  if (native?.committed || settled?.kind === "unknown" || native?.settlement?.kind === "unknown") {
    throw new ClawPortableMutationUncertainError(failure);
  }
  throw toErrorObject(failure, "Portable automation mutation did not publish a committed outcome");
}
