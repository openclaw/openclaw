import { createHash } from "node:crypto";
import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { normalizeLegacyCredentialFields } from "../../agents/auth-profiles/legacy-flat-credential.js";
import {
  readLegacyMigrationReceipt,
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
} from "../../infra/state-migrations.receipts.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
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
            beforeSha256: z.string().nullable(),
            afterSha256: z.string(),
            beforeCanonicalFieldsSha256: z.string().optional(),
            afterCanonicalFieldsSha256: z.string().optional(),
          }),
        )
        .min(1),
      sources: z.array(z.object({ path: z.string(), sha256: z.string() })).optional(),
    }),
  ),
});

type AliasReceipt = z.infer<typeof receiptSchema>;
export type AuthAliasStoreSnapshot = { databasePath: string; store: unknown };
export type AuthAliasArchiveMapping = {
  profileId: string;
  origins: readonly { sourcePath: string; sourceSha256: string; databasePath: string }[];
};

function profiles(raw: unknown): Record<string, unknown> {
  return isRecord(raw) && isRecord(raw.profiles) ? raw.profiles : {};
}

/** Persist the collision decision before independently committed owners can lose its source. */
export function recordAuthAliasMigration(params: {
  profileIdMap: ReadonlyMap<string, string>;
  stores: readonly (AuthAliasStoreSnapshot & { migratedStore: unknown })[];
  env: NodeJS.ProcessEnv;
  importedProfileIds?: ReadonlySet<string>;
  normalizeCredentialFields?: boolean;
  sources?: readonly { path: string; sha256: string }[];
}): string | undefined {
  const previousReceipt = readLegacyMigrationReceipt(SOURCE_KEY, params.env);
  const previousMappings = previousReceipt
    ? receiptSchema.parse(JSON.parse(previousReceipt.reportJson)).mappings
    : [];
  if (params.importedProfileIds) {
    for (const { from } of previousMappings) {
      if (params.importedProfileIds.has(from) && !params.profileIdMap.has(from)) {
        throw new Error(
          `Recorded auth account ${from} could not be verified; its import source was preserved.`,
        );
      }
    }
  }
  const mappings: AliasReceipt["mappings"] = [];
  for (const [from, to] of params.profileIdMap) {
    if (from === to) {
      continue;
    }
    const credentials = params.stores.flatMap(({ databasePath, store, migratedStore }) => {
      const sourceProfiles = profiles(store);
      const before = sourceProfiles[from];
      const after = profiles(migratedStore)[to];
      const current = before ?? sourceProfiles[to];
      const historical = previousMappings
        .filter((entry) => entry.from === from && entry.to === to)
        .flatMap((entry) => entry.credentials)
        .find(
          (expected) =>
            expected.databasePath === databasePath &&
            current !== undefined &&
            (before === undefined
              ? [expected.afterSha256, expected.afterCanonicalFieldsSha256]
              : [expected.beforeSha256, expected.beforeCanonicalFieldsSha256]
            ).includes(digest(current)),
        );
      if (
        after === undefined ||
        (before === undefined &&
          !historical &&
          !(params.importedProfileIds?.has(from) && params.sources?.length))
      ) {
        return [];
      }
      if (
        params.importedProfileIds?.has(from) &&
        before !== undefined &&
        (!isRecord(before) ||
          !isRecord(after) ||
          digest({ ...before, provider: after.provider }) !== digest(after))
      ) {
        throw new Error(
          `Legacy auth input conflicts with the existing account ${from}; its source was preserved.`,
        );
      }
      if (historical) {
        if (
          before === undefined &&
          (!isRecord(current) || digest(normalizeLegacyCredentialFields(current)) !== digest(after))
        ) {
          throw new Error(
            `Recorded auth account ${from} changed during migration; its source was preserved.`,
          );
        }
        return [
          {
            ...historical,
            ...(before !== undefined ? { beforeCanonicalFieldsSha256: digest(before) } : {}),
            afterCanonicalFieldsSha256: digest(after),
          },
        ];
      }
      return [
        {
          databasePath,
          beforeSha256: before === undefined ? null : digest(before),
          afterSha256: digest(after),
        },
      ];
    });
    if (credentials.length > 0) {
      mappings.push({
        from,
        to,
        credentials,
        ...(params.sources?.length ? { sources: [...params.sources] } : {}),
      });
    }
  }
  if (mappings.length === 0 && (!previousReceipt || !params.normalizeCredentialFields)) {
    return previousReceipt?.sourceSha256 ?? undefined;
  }
  return runOpenClawStateWriteTransaction(
    ({ db, path }) => {
      const prior = readLegacyMigrationReceiptFromDatabase(db, SOURCE_KEY);
      const previous = prior ? receiptSchema.parse(JSON.parse(prior.reportJson)).mappings : [];
      // A concurrent or interrupted plan must not replace an earlier committed mapping.
      const records = new Map<string, AliasReceipt["mappings"][number]>(
        params.normalizeCredentialFields ? [] : previous.map((entry) => [digest(entry), entry]),
      );
      // Preserve each owner's exact preimage and its field-only normalization.
      // Independent owner commits may settle on either side of this conversion.
      for (const entry of params.normalizeCredentialFields ? previous : []) {
        const normalized = structuredClone(entry);
        for (const expected of normalized.credentials) {
          const store = params.stores.find(
            (candidate) => candidate.databasePath === expected.databasePath,
          );
          if (!store) {
            continue;
          }
          const before = profiles(store.store);
          const after = profiles(store.migratedStore);
          for (const [id, hashKey, canonicalHashKey] of [
            [entry.from, "beforeSha256", "beforeCanonicalFieldsSha256"],
            [entry.to, "afterSha256", "afterCanonicalFieldsSha256"],
          ] as const) {
            const value = before[id];
            if (
              isRecord(value) &&
              after[id] !== undefined &&
              [expected[hashKey], expected[canonicalHashKey]].includes(digest(value)) &&
              digest(normalizeLegacyCredentialFields(value)) === digest(after[id])
            ) {
              expected[canonicalHashKey] = digest(after[id]);
            }
          }
        }
        records.set(digest(normalized), normalized);
      }
      for (const entry of mappings) {
        records.set(digest(entry), entry);
      }
      const report: AliasReceipt = { format: SOURCE_KEY, mappings: [...records.values()] };
      const reportJson = JSON.stringify(report);
      const sourceSha256 = digest(report);
      if (prior?.sourceSha256 === sourceSha256 && prior.reportJson === reportJson) {
        return sourceSha256;
      }
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
  operation: (database?: OpenClawStateDatabase) => T,
): T {
  if (expectedSha256 === undefined) {
    return operation();
  }
  return runOpenClawStateWriteTransaction(
    (database) => {
      if (
        readLegacyMigrationReceiptFromDatabase(database.db, SOURCE_KEY)?.sourceSha256 !==
        expectedSha256
      ) {
        throw new Error("Auth alias migration receipt changed before repair; rerun Doctor.");
      }
      return operation(database);
    },
    { env },
  );
}

/** Recover only a recorded account, never a same-suffix credential or a newly reused source ID. */
export function recoverAuthAliasMigration(params: {
  stores: readonly AuthAliasStoreSnapshot[];
  env: NodeJS.ProcessEnv;
  archivedMappings?: ReadonlyMap<string, AuthAliasArchiveMapping>;
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
    const sourcePaths = mapping.sources?.map((source) => source.path) ?? [];
    const archived =
      sourcePaths.length > 0 && sourcePaths.every((source) => !fs.existsSync(source));
    let matched: boolean;
    if (archived) {
      // The import owner validates archived bytes, refreshed OAuth identity and ambiguity.
      const archive = params.archivedMappings?.get(mapping.from);
      const recordedSources = report.mappings
        .filter((entry) => entry.from === mapping.from && entry.to === mapping.to)
        .flatMap((entry) => entry.sources ?? []);
      const verifiedStores = new Set(
        archive?.origins
          .filter((origin) =>
            recordedSources.some(
              (source) =>
                source.path === origin.sourcePath && source.sha256 === origin.sourceSha256,
            ),
          )
          .map((origin) => origin.databasePath),
      );
      matched =
        archive?.profileId === mapping.to &&
        verifiedStores.size > 0 &&
        [...stores].every(
          ([databasePath, entries]) =>
            entries[mapping.from] === undefined &&
            (entries[mapping.to] === undefined || verifiedStores.has(databasePath)),
        );
    } else {
      matched =
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
              [expected.beforeSha256, expected.beforeCanonicalFieldsSha256].includes(
                digest(before),
              )) ||
            (before === undefined &&
              after !== undefined &&
              [expected.afterSha256, expected.afterCanonicalFieldsSha256].includes(
                digest(after),
              )) ||
            (before === undefined &&
              after === undefined &&
              expected.beforeSha256 === null &&
              mapping.sources !== undefined &&
              mapping.sources.length > 0 &&
              mapping.sources.every((source) => {
                try {
                  return (
                    createHash("sha256").update(fs.readFileSync(source.path)).digest("hex") ===
                    source.sha256
                  );
                } catch (error) {
                  if (isRecord(error) && error.code === "ENOENT") {
                    return false;
                  }
                  throw error;
                }
              }))
          );
        }) &&
        [...stores].every(
          ([databasePath, entries]) =>
            mapping.credentials.some((entry) => entry.databasePath === databasePath) ||
            (entries[mapping.from] === undefined && entries[mapping.to] === undefined),
        );
    }
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
    } else {
      blocked.add(from);
    }
  }
  return { recovered, blocked };
}
