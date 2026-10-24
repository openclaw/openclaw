// Doctor-only import for the retired device-auth JSON store.
import fs from "node:fs";
import path from "node:path";
import { root } from "@openclaw/fs-safe";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeDeviceAuthRole, normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { importClientCredentialLegacy } from "./client-credential-legacy.js";
import {
  writeClientCredentialReceipt,
  assertClientCredentialStoreReady,
  readClientCredentialReceipt,
} from "./client-credential-readiness.js";
import {
  emptyClientCredentialReceipt,
  readClientCredentialFileIdentity,
  type ClientCredentialReceipt,
} from "./client-credential-receipt.js";
import type { ClientCredentialDatabase } from "./client-credential-schema.js";
import { openClientCredentialCustody } from "./client-credential-store.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import { readLegacyMigrationSourceSnapshot } from "./state-migrations.source-snapshot.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";
import { decodeUtf8Input } from "./utf8-input.js";

const LEGACY_SOURCES = [
  { profile: "primary", relativePath: "identity/device-auth.json" },
  { profile: "node", relativePath: "identity/node-device-auth.json" },
  { profile: "shareExtension", relativePath: "identity/share-device-auth.json" },
] as const;
type LegacyDeviceAuthSource = (typeof LEGACY_SOURCES)[number];
const MAX_BYTES = 256 * 1024;
type DeviceAuthMigrationDatabase = Pick<ClientCredentialDatabase, "device_auth_tokens">;

function sourceCandidates(stateDir: string, source: LegacyDeviceAuthSource): string[] {
  const sourcePath = path.join(stateDir, source.relativePath);
  return [sourcePath, `${sourcePath}.doctor-importing`, `${sourcePath}.native-importing`];
}

/** Detect the retired device-auth store only when an explicit Doctor flow opts in. */
export function detectLegacyDeviceAuth(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["deviceAuth"] {
  const existingSourcePath = LEGACY_SOURCES.flatMap((source) =>
    sourceCandidates(params.stateDir, source),
  ).find((candidate) => fs.existsSync(candidate));
  const sourcePath =
    existingSourcePath ?? path.join(params.stateDir, LEGACY_SOURCES[0].relativePath);
  const sourcePresent = existingSourcePath !== undefined;
  return {
    sourcePath,
    sourcePresent,
    hasLegacy: params.doctorOnlyStateMigrations === true && sourcePresent,
  };
}

function parseStore(value: unknown) {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.deviceId !== "string" ||
    !value.deviceId.trim() ||
    !isRecord(value.tokens)
  ) {
    throw new Error("legacy device-auth store is invalid or unsupported");
  }
  const entries = Object.entries(value.tokens).flatMap(([rawRole, tokenValue]) => {
    const role = normalizeDeviceAuthRole(rawRole);
    if (!role || !isRecord(tokenValue) || typeof tokenValue.token !== "string") {
      return [];
    }
    return [
      {
        token: tokenValue.token,
        role,
        scopes: normalizeDeviceAuthScopes(
          Array.isArray(tokenValue.scopes) ? tokenValue.scopes : undefined,
        ),
        updatedAtMs:
          typeof tokenValue.updatedAtMs === "number" && Number.isSafeInteger(tokenValue.updatedAtMs)
            ? tokenValue.updatedAtMs
            : 0,
      },
    ];
  });
  // JSON object order is the legacy contract; later aliases of the same
  // normalized role replace earlier entries before SQLite conflict handling.
  return {
    deviceId: value.deviceId,
    entries: [...new Map(entries.map((entry) => [entry.role, entry])).values()],
  };
}

function rowIsCanonical(row: { scopes_json: string; updated_at_ms: number }): boolean {
  try {
    return Array.isArray(JSON.parse(row.scopes_json)) && Number.isSafeInteger(row.updated_at_ms);
  } catch {
    return false;
  }
}

async function readLegacyDeviceAuthSource(stateDir: string, source: LegacyDeviceAuthSource) {
  const stateRoot = await root(stateDir, {
    hardlinks: "reject",
    maxBytes: MAX_BYTES,
    symlinks: "reject",
  });
  const snapshots = [];
  for (const sourcePath of sourceCandidates(stateDir, source)) {
    if (await stateRoot.exists(path.relative(stateDir, sourcePath))) {
      snapshots.push(
        await readLegacyMigrationSourceSnapshot({
          stateRoot,
          stateDir,
          sourcePath,
          maxBytes: MAX_BYTES,
          label: "device auth",
        }),
      );
    }
  }
  const snapshot = snapshots[0];
  if (!snapshot) {
    return undefined;
  }
  if (snapshots.some((other) => other.sha256 !== snapshot.sha256)) {
    throw new Error(
      "Legacy device-auth files disagree; preserve them and resolve the conflict before importing.",
    );
  }
  const text = decodeUtf8Input(snapshot.buffer, `Legacy device-auth store ${snapshot.sourcePath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Legacy device-auth store is invalid or unsupported.");
  }
  return { snapshot, store: parseStore(parsed) };
}

/** Preparation shares the importer parser and never reopens a consumed JSON input. */
export async function prepareLegacyDeviceAuth(params: {
  stateDir: string;
  legacyImports: ClientCredentialReceipt["legacyImports"];
}): Promise<void> {
  for (const source of LEGACY_SOURCES) {
    if (
      !params.legacyImports[`auth:${source.profile}`] &&
      sourceCandidates(params.stateDir, source).some((candidate) => fs.existsSync(candidate))
    ) {
      await readLegacyDeviceAuthSource(params.stateDir, source);
    }
  }
}

/** Import retired device-auth JSON while excluding Gateways that can rewrite it. */
export async function migrateLegacyDeviceAuth(params: {
  detected: LegacyStateDetection["deviceAuth"];
  stateDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<MigrationMessages> {
  if (!params.detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  const results: MigrationMessages[] = [];
  for (const source of LEGACY_SOURCES) {
    if (sourceCandidates(params.stateDir, source).some((candidate) => fs.existsSync(candidate))) {
      results.push(await migrateLegacyDeviceAuthSource({ ...params, source }));
    }
  }
  return {
    changes: results.flatMap((result) => result.changes),
    warnings: results.flatMap((result) => result.warnings),
    ...(results.some((result) => result.notices?.length)
      ? { notices: results.flatMap((result) => result.notices ?? []) }
      : {}),
  };
}

async function migrateLegacyDeviceAuthSource(params: {
  source: LegacyDeviceAuthSource;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<MigrationMessages> {
  const claimKey = `auth:${params.source.profile}` as const;
  return await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "legacy device auth",
    releaseLabel: "Device-auth",
    errorLabel: "Failed migrating legacy device auth",
    run: async (env) => {
      const owner = openClientCredentialCustody(env, { createIfMissing: true, migration: true });
      if (!owner) {
        throw new Error("Local client credentials are unavailable.");
      }
      let counts: { imported: number; preserved: number };
      try {
        const prior = readClientCredentialReceipt(owner.database);
        if (prior) {
          owner.transaction(() => assertClientCredentialStoreReady(owner.database, env, false));
          if (prior.receipt.legacyImports[claimKey]) {
            return {
              changes: [],
              warnings: [],
              notices: [
                "Retained legacy device-auth JSON is already consumed; local credentials remain authoritative.",
              ],
            };
          }
        }
        const prepared = await readLegacyDeviceAuthSource(params.stateDir, params.source);
        if (!prepared) {
          return { changes: [], warnings: [] };
        }
        const { snapshot: source, store } = prepared;
        counts = owner.transaction(() => {
          const db = owner.database;
          if (!readClientCredentialReceipt(db)) {
            if (readClientCredentialFileIdentity(resolveOpenClawStateSqlitePath(env))) {
              throw new Error(
                "Prepare the shared credential migration before importing legacy tokens.",
              );
            }
            writeClientCredentialReceipt(db, emptyClientCredentialReceipt(), "complete");
          }
          assertClientCredentialStoreReady(db, env, false);
          if (readClientCredentialReceipt(db)?.receipt.legacyImports[claimKey]) {
            return { imported: 0, preserved: store.entries.length };
          }
          const stateDb = getNodeSqliteKysely<DeviceAuthMigrationDatabase>(db);
          let imported = 0;
          let preserved = 0;
          for (const entry of store.entries) {
            const existing = executeSqliteQueryTakeFirstSync(
              db,
              stateDb
                .selectFrom("device_auth_tokens")
                .select(["scopes_json", "updated_at_ms"])
                .where("device_id", "=", store.deviceId)
                .where("role", "=", entry.role),
            );
            if (existing && rowIsCanonical(existing)) {
              preserved += 1;
            } else {
              if (existing) {
                executeSqliteQuerySync(
                  db,
                  stateDb
                    .deleteFrom("device_auth_tokens")
                    .where("device_id", "=", store.deviceId)
                    .where("role", "=", entry.role),
                );
              }
              imported += 1;
            }
          }
          importClientCredentialLegacy(owner, {
            key: claimKey,
            sha256: source.sha256,
            tokens: store.entries.map((entry) => ({
              device_id: store.deviceId,
              role: entry.role,
              token: entry.token,
              scopes_json: JSON.stringify(entry.scopes),
              updated_at_ms: entry.updatedAtMs,
            })),
          });
          return { imported, preserved };
        });
      } finally {
        owner.close();
      }
      return {
        changes: [
          `Migrated ${counts.imported} device-auth token${counts.imported === 1 ? "" : "s"} to SQLite.`,
        ],
        warnings: [],
        notices: [
          ...(counts.preserved > 0
            ? [
                `Preserved ${counts.preserved} canonical SQLite device-auth token${counts.preserved === 1 ? "" : "s"}.`,
              ]
            : []),
          "Legacy device-auth JSON was retained unchanged; its durable local claim prevents reimport.",
        ],
      };
    },
  });
}
