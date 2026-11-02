import path from "node:path";
import { z } from "zod";
import type { ConfigFileWritePathSnapshot } from "../config/io.write-path.types.js";
import { StrictPluginInstallRecordSchema } from "../config/zod-schema.installs.js";
import { PluginSourceSnapshotIndexChangeSchema } from "../plugins/plugin-source-snapshot.types.js";
import type { UpdateRecoveryRecord } from "./update-run-recovery-schema.js";

export const PLUGIN_COHORT_RECOVERY_KEY_PREFIX = "update.pluginCohort.";
export const PLUGIN_COHORT_RECOVERY_KEY_END = "update.pluginCohort/";
const MAX_PLUGIN_COHORT_BYTES = 1024 * 1024;
const text = z.string().min(1).max(32_768);
const absolutePath = text.refine((value) => path.isAbsolute(value));
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z.strictObject({
  realPath: absolutePath,
  dev: z.string().regex(/^\d+$/u),
  ino: z.string().regex(/^\d+$/u),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const installRecord = StrictPluginInstallRecordSchema.passthrough();
const configPathSnapshot = z.strictObject({
  targetPath: absolutePath,
  entries: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({ path: absolutePath, kind: z.literal("missing-directory") }),
        z.strictObject({
          path: absolutePath,
          kind: z.literal("existing"),
          dev: text,
          ino: text,
          link: text.optional(),
        }),
      ]),
    )
    .max(1024),
}) satisfies z.ZodType<ConfigFileWritePathSnapshot>;
const configFileIntent = z
  .strictObject({
    rootConfigPath: absolutePath,
    filePath: absolutePath,
    targetPath: absolutePath,
    pathSnapshot: configPathSnapshot,
    beforeRaw: z.string().max(MAX_PLUGIN_COHORT_BYTES).nullable(),
    afterRaw: z.string().max(MAX_PLUGIN_COHORT_BYTES),
    include: z
      .strictObject({ boundaryPath: z.array(text).min(1).max(256), includePath: absolutePath })
      .optional(),
  })
  .refine(
    (file) =>
      file.targetPath === file.pathSnapshot.targetPath &&
      (file.include
        ? file.filePath === file.include.includePath
        : file.filePath === file.rootConfigPath),
    {
      message: "Plugin cohort configuration publication target differs from its owning path",
    },
  );
export type PluginCohortConfigFileIntent = z.infer<typeof configFileIntent>;

export const PluginCohortMigrationRowSchema = z.strictObject({
  startedAt: counter,
  finishedAt: counter.nullable(),
  status: z.enum(["pending", "completed", "superseded", "deferred"]),
  reportJson: z.string().max(MAX_PLUGIN_COHORT_BYTES),
});
const pluginMigrationPublication = z.strictObject({
  kind: z.literal("plugin-migrations"),
  rows: z
    .array(
      z.strictObject({
        pluginId: text,
        before: PluginCohortMigrationRowSchema.optional(),
        after: PluginCohortMigrationRowSchema,
      }),
    )
    .max(4096)
    .refine((rows) => new Set(rows.map((row) => row.pluginId)).size === rows.length, {
      message: "Plugin migration publication repeats an owner",
    }),
});
export type PluginCohortMigrationPublication = z.infer<typeof pluginMigrationPublication>;

const pluginCohortRecoverySchema = z
  .strictObject({
    runId: z.uuid(),
    transactionId: z.uuid(),
    revision: counter,
    disposition: z.enum(["pending", "commit", "rollback"]),
    installKey: absolutePath,
    priorArtifacts: z
      .array(
        z
          .strictObject({
            pluginId: text,
            packageDir: absolutePath,
            identity: identity.nullable(),
            record: installRecord.optional(),
            markerBefore: z.string().max(MAX_PLUGIN_COHORT_BYTES).nullable(),
            markerAfter: z.string().max(MAX_PLUGIN_COHORT_BYTES).nullable(),
          })
          .refine(
            (artifact) =>
              artifact.identity !== null ||
              (artifact.record?.source === "npm" &&
                artifact.record.installPath === artifact.packageDir &&
                artifact.markerBefore === null &&
                artifact.markerAfter === null),
            {
              message:
                "Absent plugin cohort payload must retain its matching record without markers",
            },
          ),
      )
      .max(4096),
    artifacts: z
      .array(
        z.strictObject({
          pluginId: text,
          packageName: text,
          targetNpmRoot: absolutePath,
          targetPackageDir: absolutePath,
          stagedIdentity: identity,
          identity: identity.optional(),
          markerAfter: z.string().max(MAX_PLUGIN_COHORT_BYTES).nullable().optional(),
        }),
      )
      .max(4096),
    publications: z
      .array(
        z.discriminatedUnion("kind", [
          z.strictObject({
            kind: z.literal("records"),
            sourceSnapshots: z.array(PluginSourceSnapshotIndexChangeSchema).max(4096).optional(),
            records: z
              .array(
                z.strictObject({
                  pluginId: text,
                  before: installRecord.optional(),
                  after: installRecord.optional(),
                }),
              )
              .max(4096),
          }),
          z.strictObject({ kind: z.literal("config"), file: configFileIntent }),
          pluginMigrationPublication,
        ]),
      )
      .max(4096),
    settledPublications: counter,
  })
  .refine((cohort) => cohort.settledPublications <= cohort.publications.length, {
    message: "Plugin cohort settlement exceeds its publications",
  });

export type PluginCohortRecovery = z.infer<typeof pluginCohortRecoverySchema>;
export type PluginCohortRecoveryPair = {
  reservation: UpdateRecoveryRecord;
  cohort: PluginCohortRecovery;
};
export type PluginCohortRecoveryBinding = Pick<PluginCohortRecovery, "runId" | "transactionId">;
export const PluginCohortRecoveryWriteBindingSchema = z.strictObject({
  runId: z.uuid(),
  transactionId: z.uuid(),
  installKey: absolutePath,
});
export type PluginCohortRecoveryWriteBinding = z.infer<
  typeof PluginCohortRecoveryWriteBindingSchema
>;

/** This exact old-reader shape reserves the operation; it never claims full-state recovery. */
function assertPluginCohortReservation(reservation: UpdateRecoveryRecord): void {
  if (!reservation.source) {
    throw new Error("Plugin cohort reservation requires its original state source");
  }
  const allowed = new Set([
    "runId",
    "transactionId",
    "revision",
    "claimId",
    "claimKind",
    "handoff",
    "source",
    "from",
    "to",
    "createdAtMs",
    "updatedAtMs",
    "effects",
    "restore",
    "verification",
    "primaryFailure",
  ]);
  if (
    Object.keys(reservation).some((key) => !allowed.has(key)) ||
    reservation.effects.length !== 0 ||
    reservation.handoff !== null ||
    reservation.restore !== null ||
    reservation.verification !== null ||
    reservation.primaryFailure !== null
  ) {
    throw new Error("Plugin cohort reservation contains full-state recovery");
  }
}

export function decodePluginCohortRecovery(raw: string, runId: string): PluginCohortRecovery {
  if (Buffer.byteLength(raw) > MAX_PLUGIN_COHORT_BYTES) {
    throw new Error("Plugin cohort recovery exceeds its storage limit");
  }
  const cohort = pluginCohortRecoverySchema.parse(JSON.parse(raw));
  if (cohort.runId !== runId) {
    throw new Error("Plugin cohort recovery does not match its history run");
  }
  return cohort;
}

export function encodePluginCohortRecovery(cohort: PluginCohortRecovery): string {
  const raw = JSON.stringify(cohort);
  decodePluginCohortRecovery(raw, cohort.runId);
  return raw;
}

export function assertPluginCohortRecoveryBinding(pair: PluginCohortRecoveryPair): void {
  assertPluginCohortReservation(pair.reservation);
  if (
    pair.reservation.runId !== pair.cohort.runId ||
    pair.reservation.transactionId !== pair.cohort.transactionId
  ) {
    throw new Error("Plugin cohort recovery does not match its reservation");
  }
}
