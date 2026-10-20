import { createHash } from "node:crypto";
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
} from "./client-credential-receipt.js";
import type { ClientCredentialDatabase } from "./client-credential-schema.js";
import { openClientCredentialCustody } from "./client-credential-store.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

const LEGACY_PATH = "identity/device-auth.json";
type DeviceAuthMigrationDatabase = Pick<ClientCredentialDatabase, "device_auth_tokens">;

/** Detect the retired device-auth store only when an explicit Doctor flow opts in. */
export function detectLegacyDeviceAuth(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["deviceAuth"] {
  const sourcePath = path.join(params.stateDir, LEGACY_PATH);
  const sourcePresent = fs.existsSync(sourcePath);
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

/** Import retired device-auth JSON while excluding Gateways that can rewrite it. */
export async function migrateLegacyDeviceAuth(params: {
  detected: LegacyStateDetection["deviceAuth"];
  stateDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<MigrationMessages> {
  if (!params.detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }
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
          if (prior.receipt.legacyImports["auth:primary"]) {
            return {
              changes: [],
              warnings: [],
              notices: [
                "Retained legacy device-auth JSON is already consumed; local credentials remain authoritative.",
              ],
            };
          }
        }
        const stateRoot = await root(params.stateDir, {
          hardlinks: "reject",
          maxBytes: 256 * 1024,
          symlinks: "reject",
        });
        const source = await stateRoot.read(LEGACY_PATH, {
          hardlinks: "reject",
          maxBytes: 256 * 1024,
          symlinks: "reject",
        });
        let parsed: unknown;
        try {
          parsed = JSON.parse(source.buffer.toString("utf8"));
        } catch {
          throw new Error("Legacy device-auth store is invalid or unsupported.");
        }
        const store = parseStore(parsed);
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
          if (readClientCredentialReceipt(db)?.receipt.legacyImports["auth:primary"]) {
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
            key: "auth:primary",
            sha256: createHash("sha256").update(source.buffer).digest("hex"),
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
