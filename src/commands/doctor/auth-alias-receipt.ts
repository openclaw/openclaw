import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import {
  readLegacyMigrationReceipt,
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
} from "../../infra/state-migrations.receipts.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { digestAuthProfileMigrationValue as digest } from "../doctor-auth-migration-receipts.js";

const SOURCE_KEY = "auth-profile-sqlite-alias-map:v1";
const receiptSchema = z.object({
  format: z.literal(SOURCE_KEY),
  mappings: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      credentials: z
        .array(
          z.object({
            databasePath: z.string(),
            beforeSha256: z.string(),
            afterSha256: z.string(),
          }),
        )
        .min(1),
    }),
  ),
});

type AliasReceipt = z.infer<typeof receiptSchema>;
export type AuthAliasStoreSnapshot = { databasePath: string; store: unknown };

function profiles(raw: unknown): Record<string, unknown> {
  return isRecord(raw) && isRecord(raw.profiles) ? raw.profiles : {};
}

/** Persist the collision decision before independently committed owners can lose its source. */
export function recordAuthAliasMigration(params: {
  profileIdMap: ReadonlyMap<string, string>;
  stores: readonly (AuthAliasStoreSnapshot & { migratedStore: unknown })[];
  env: NodeJS.ProcessEnv;
}): string | undefined {
  const mappings: AliasReceipt["mappings"] = [];
  for (const [from, to] of params.profileIdMap) {
    if (from === to) {
      continue;
    }
    const credentials = params.stores.flatMap(({ databasePath, store, migratedStore }) => {
      const before = profiles(store)[from];
      const after = profiles(migratedStore)[to];
      return before !== undefined && after !== undefined
        ? [{ databasePath, beforeSha256: digest(before), afterSha256: digest(after) }]
        : [];
    });
    if (credentials.length > 0) {
      mappings.push({ from, to, credentials });
    }
  }
  if (mappings.length === 0) {
    return readLegacyMigrationReceipt(SOURCE_KEY, params.env)?.sourceSha256 ?? undefined;
  }
  return runOpenClawStateWriteTransaction(
    ({ db, path }) => {
      const prior = readLegacyMigrationReceiptFromDatabase(db, SOURCE_KEY);
      const previous = prior ? receiptSchema.parse(JSON.parse(prior.reportJson)).mappings : [];
      // A concurrent or interrupted plan must not replace an earlier committed mapping.
      const records = new Map(previous.map((entry) => [digest(entry), entry]));
      for (const entry of mappings) {
        records.set(digest(entry), entry);
      }
      const report: AliasReceipt = { format: SOURCE_KEY, mappings: [...records.values()] };
      const reportJson = JSON.stringify(report);
      const sourceSha256 = digest(report);
      recordLegacyMigrationReceipt(db, {
        sourceKey: SOURCE_KEY,
        migrationKind: "auth-profile-sqlite-alias-map",
        sourcePath: path,
        targetTable: "migration_sources",
        sourceSha256,
        sourceSizeBytes: null,
        sourceRecordCount: report.mappings.length,
        runId: `${SOURCE_KEY}:${sourceSha256}`,
        now: Date.now(),
        reportJson,
        upsert: true,
      });
      return sourceSha256;
    },
    { env: params.env },
  );
}

export function runWithAuthAliasMigrationReceipt<T>(
  expectedSha256: string | undefined,
  env: NodeJS.ProcessEnv,
  operation: () => T,
): T {
  if (expectedSha256 === undefined) {
    return operation();
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (readLegacyMigrationReceiptFromDatabase(db, SOURCE_KEY)?.sourceSha256 !== expectedSha256) {
        throw new Error("Auth alias migration receipt changed before repair; rerun Doctor.");
      }
      return operation();
    },
    { env },
  );
}

/** Recover only a recorded account, never a same-suffix credential or a newly reused source ID. */
export function recoverAuthAliasMigration(params: {
  stores: readonly AuthAliasStoreSnapshot[];
  env: NodeJS.ProcessEnv;
}): { recovered: Map<string, string>; blocked: Set<string> } {
  const recovered = new Map<string, string>();
  const blocked = new Set<string>();
  const receipt = readLegacyMigrationReceipt(SOURCE_KEY, params.env);
  if (!receipt) {
    return { recovered, blocked };
  }
  const report = receiptSchema.parse(JSON.parse(receipt.reportJson));
  const stores = new Map(params.stores.map((entry) => [entry.databasePath, profiles(entry.store)]));
  const matches = new Map<string, Set<string>>();
  for (const mapping of report.mappings) {
    const matched =
      mapping.credentials.every((expected) => {
        const entries = stores.get(expected.databasePath);
        if (!entries) {
          return false;
        }
        const before = entries[mapping.from];
        const after = entries[mapping.to];
        return (
          (before !== undefined &&
            after === undefined &&
            digest(before) === expected.beforeSha256) ||
          (before === undefined && after !== undefined && digest(after) === expected.afterSha256)
        );
      }) &&
      [...stores].every(
        ([databasePath, entries]) =>
          mapping.credentials.some((entry) => entry.databasePath === databasePath) ||
          (entries[mapping.from] === undefined && entries[mapping.to] === undefined),
      );
    if (matched) {
      const targets = matches.get(mapping.from) ?? new Set<string>();
      targets.add(mapping.to);
      matches.set(mapping.from, targets);
    }
  }
  for (const from of new Set(report.mappings.map((entry) => entry.from))) {
    const targets = matches.get(from);
    if (targets?.size === 1) {
      for (const to of targets) {
        recovered.set(from, to);
      }
    } else if (
      targets?.size ||
      ![...stores.values()].some((entries) => entries[from] !== undefined)
    ) {
      blocked.add(from);
    }
  }
  return { recovered, blocked };
}
