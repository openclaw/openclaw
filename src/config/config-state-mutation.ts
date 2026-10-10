import { randomUUID } from "node:crypto";
import { z } from "zod";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { prepareSqliteAuditRecord } from "../infra/sqlite-audit-record.kernel.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { findStartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";
import { redactSecrets } from "../logging/redact.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { CONFIG_SNAPSHOT_SCOPE, CONFIG_SNAPSHOT_KEY } from "./config-journal-snapshot.kernel.js";
import { CONFIG_AUDIT_SCOPE, CONFIG_AUDIT_MAX_ENTRIES } from "./io.audit-policy.js";

const snapshot = z.strictObject({
  configPath: z.string(),
  rawHash: z.string(),
  fingerprintedAuthoredConfig: z.unknown(),
});
const nullableString = z.string().nullable();
export const configStateMutationSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("audit"),
    record: z.looseObject({
      ts: z.string(),
      source: z.literal("config-io"),
      event: z.enum(["config.write", "config.observe", "config.external"]),
      configPath: z.string(),
    }),
  }),
  z.strictObject({
    kind: z.literal("snapshot"),
    snapshot: snapshot.nullable(),
    expectedSnapshot: snapshot.nullable().optional(),
  }),
  z.strictObject({ kind: z.literal("metadata"), now: z.string() }),
  z.strictObject({
    kind: z.literal("health"),
    configPath: z.string(),
    patch: z.strictObject({
      last_known_good_json: nullableString.optional(),
      last_promoted_good_json: nullableString.optional(),
      last_observed_suspicious_signature: nullableString.optional(),
    }),
    expected: z
      .strictObject({
        lastKnownGoodJson: nullableString,
        lastPromotedGoodJson: nullableString,
        suspiciousSignature: nullableString,
        updatedAtMs: z.number(),
      })
      .nullable()
      .optional(),
    updatedAtMs: z.number(),
  }),
]);
type ConfigStateMutation = z.infer<typeof configStateMutationSchema>;

/** The same operation runs in the serving process or under exclusive offline custody. */
export async function applyConfigStateMutation(
  mutation: ConfigStateMutation,
  env: NodeJS.ProcessEnv,
  assertCurrent: () => void,
): Promise<boolean> {
  assertCurrent();
  const context = captureOpenClawStateWorkerContext({ env });
  return await runOpenClawStateWorkerOperation(
    context,
    async (store) => {
      switch (mutation.kind) {
        case "audit": {
          const record = redactSecrets(mutation.record);
          await store.execute({
            type: "diagnostic.register",
            input: {
              scope: CONFIG_AUDIT_SCOPE,
              maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
              record: prepareSqliteAuditRecord(CONFIG_AUDIT_SCOPE, {
                key: `${record.ts}:${record.event}:${randomUUID()}`,
                value: record,
                createdAt: Date.parse(record.ts),
              }),
            },
          });
          return true;
        }
        case "snapshot":
          return await store.execute({
            type: "config.snapshot.upsert",
            input: {
              record:
                mutation.snapshot === null
                  ? null
                  : prepareSqliteAuditRecord(CONFIG_SNAPSHOT_SCOPE, {
                      key: CONFIG_SNAPSHOT_KEY,
                      value: mutation.snapshot,
                      createdAt: Date.now(),
                    }),
              expectedPayloadJson:
                mutation.expectedSnapshot === null
                  ? null
                  : JSON.stringify(mutation.expectedSnapshot),
            },
          });
        case "metadata":
          await store.execute({ type: "config.metadata.write", input: { now: mutation.now } });
          return true;
        case "health":
          return await store.execute({
            type: "config.health.patch",
            input: {
              configPath: mutation.configPath,
              patch: mutation.patch,
              expected: mutation.expected,
              updatedAtMs: mutation.updatedAtMs,
            },
          });
      }
      throw new Error("Unsupported config state mutation");
    },
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
}

export async function mutateConfigState(
  mutation: ConfigStateMutation,
  env: NodeJS.ProcessEnv,
  assertCurrent?: () => void,
): Promise<boolean> {
  try {
    return await runWithLocalStateOwner({
      env,
      method: "config.state.mutate",
      params: { mutation },
      target: "config ancillary state",
      recoveryCommand: "openclaw config get",
      assertTargetCurrent: assertCurrent,
      runLocal: ({ env: ownerEnv, assertCurrent: assertOwnerCurrent }) =>
        applyConfigStateMutation(mutation, ownerEnv, assertOwnerCurrent),
    });
  } catch (error) {
    const { isGatewayClientRequestError } = await import("../gateway/call.js");
    for (const cause of collectNestedErrorCandidates(error)) {
      if (
        isGatewayClientRequestError(cause) &&
        typeof cause.details === "object" &&
        cause.details !== null &&
        "configStateError" in cause.details
      ) {
        const failure = new Error(cause.message);
        retainOpenClawStateWorkerErrorPayload(failure, cause.details.configStateError);
        // The owner replied; preserve its failure without retrying the accepted mutation.
        throw hydrateOpenClawStateWorkerError(failure, { includeOrdinary: true });
      }
    }
    throw findStartupMaintenanceRequiredError(error) ?? error;
  }
}
