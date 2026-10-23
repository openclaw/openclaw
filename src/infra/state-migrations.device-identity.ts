import type { DatabaseSync } from "node:sqlite";
import { root, type Root } from "@openclaw/fs-safe";
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
import { normalizeLegacyDeviceIdentity } from "./device-identity-legacy.js";
import { storedDeviceIdentityFromRow } from "./device-identity-material.js";
import { validateStoredDeviceIdentity, type DeviceIdentity } from "./device-identity-store.js";
import { deriveEd25519PrivateKeyRaw, deriveEd25519PublicKeyRaw } from "./ed25519-signature.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  hasLegacyDeviceIdentityPath,
  detectLegacyDeviceIdentity,
  repairInvalidCanonicalIdentity,
} from "./state-migrations.device-identity-repair.js";
import type {
  LegacyDeviceIdentityDetection,
  LegacyDeviceIdentitySource,
} from "./state-migrations.device-identity.types.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import { readLegacyMigrationSourceSnapshot } from "./state-migrations.source-snapshot.js";
import type { MigrationMessages } from "./state-migrations.types.js";

export { detectLegacyDeviceIdentity };
const MAX_BYTES = 128 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function readCanonicalIdentity(db: DatabaseSync, identityKey: string) {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<Pick<ClientCredentialDatabase, "device_identities">>(db)
      .selectFrom("device_identities")
      .selectAll()
      .where("identity_key", "=", identityKey),
  );
}

function sameKeys(left: DeviceIdentity, right: DeviceIdentity): boolean {
  return (
    left.deviceId === right.deviceId &&
    deriveEd25519PublicKeyRaw(left.publicKeyPem).equals(
      deriveEd25519PublicKeyRaw(right.publicKeyPem),
    ) &&
    deriveEd25519PrivateKeyRaw(left.privateKeyPem).equals(
      deriveEd25519PrivateKeyRaw(right.privateKeyPem),
    )
  );
}

async function readSource(stateRoot: Root, stateDir: string, sourcePath: string) {
  const snapshot = await readLegacyMigrationSourceSnapshot({
    stateRoot,
    stateDir,
    sourcePath,
    maxBytes: MAX_BYTES,
    label: "device identity",
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(snapshot.buffer));
  } catch {
    throw new Error("Legacy device identity is invalid or unsupported.");
  }
  const identity = normalizeLegacyDeviceIdentity(parsed);
  if (!identity) {
    throw new Error("Legacy device identity is invalid or unsupported.");
  }
  return { ...snapshot, identity };
}

async function readLegacyIdentitySource(stateDir: string, detected: LegacyDeviceIdentitySource) {
  const stateRoot = await root(stateDir, {
    hardlinks: "reject",
    maxBytes: MAX_BYTES,
    symlinks: "reject",
  });
  const snapshots = [];
  for (const sourcePath of [detected.sourcePath, detected.claimPath, detected.nativeClaimPath]) {
    if (await stateRoot.exists(sourcePath.slice(stateDir.length + 1))) {
      snapshots.push(await readSource(stateRoot, stateDir, sourcePath));
    }
  }
  const snapshot = snapshots[0];
  if (snapshot && snapshots.some((other) => other.sha256 !== snapshot.sha256)) {
    throw new Error(
      "Legacy identity files disagree; preserve them and resolve the conflict before importing.",
    );
  }
  return snapshot;
}

/** Validate only inputs that automatic startup would import, without acquiring write custody. */
export async function prepareLegacyDeviceIdentity(params: {
  stateDir: string;
  identities: readonly ClientCredentialDatabase["device_identities"][];
  legacyImports: ClientCredentialReceipt["legacyImports"];
}): Promise<LegacyDeviceIdentityDetection> {
  const detected = detectLegacyDeviceIdentity({ stateDir: params.stateDir });
  for (const source of detected.sources) {
    const canonical = params.identities.find((row) => row.identity_key === source.identityKey);
    if (canonical) {
      // Automatic migration cannot rotate or repair a corrupt canonical identity.
      storedDeviceIdentityFromRow(canonical, source.identityKey);
    }
    source.hasLegacy =
      !canonical &&
      !params.legacyImports[`identity:${source.identityKey}`] &&
      hasLegacyDeviceIdentityPath(source);
    if (source.hasLegacy) {
      await readLegacyIdentitySource(params.stateDir, source);
    }
  }
  detected.hasLegacy = detected.sources.some((source) => source.hasLegacy);
  return detected;
}

/** Copy-only import: retained JSON never becomes authoritative after its durable claim. */
export async function migrateLegacyDeviceIdentity(params: {
  detected: LegacyDeviceIdentityDetection;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  doctorOnlyStateMigrations?: boolean;
}): Promise<MigrationMessages> {
  const results: MigrationMessages[] = [];
  for (const detected of params.detected.sources) {
    results.push(await migrateLegacyDeviceIdentitySource({ ...params, detected }));
  }
  return {
    changes: results.flatMap((result) => result.changes),
    warnings: results.flatMap((result) => result.warnings),
    ...(results.some((result) => result.notices?.length)
      ? { notices: results.flatMap((result) => result.notices ?? []) }
      : {}),
  };
}

async function migrateLegacyDeviceIdentitySource(params: {
  detected: LegacyDeviceIdentitySource;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  doctorOnlyStateMigrations?: boolean;
}): Promise<MigrationMessages> {
  const identityKey = params.detected.identityKey;
  const claimKey = `identity:${identityKey}` as const;
  if (
    (!params.detected.hasLegacy && !params.detected.hasInvalidCanonical) ||
    params.doctorOnlyStateMigrations !== true
  ) {
    return { changes: [], warnings: [] };
  }
  return await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "legacy device identity",
    releaseLabel: "Device identity",
    errorLabel: "Failed reading legacy device identity state",
    run: async (env) => {
      if (!hasLegacyDeviceIdentityPath(params.detected)) {
        return params.detected.hasInvalidCanonical
          ? repairInvalidCanonicalIdentity(env, identityKey)
          : { changes: [], warnings: [] };
      }
      const owner = openClientCredentialCustody(env, { createIfMissing: true, migration: true });
      if (!owner) {
        throw new Error("Local client credentials are unavailable.");
      }
      try {
        const stored = readClientCredentialReceipt(owner.database);
        if (stored) {
          owner.transaction(() => assertClientCredentialStoreReady(owner.database, env, false));
          if (stored.receipt.legacyImports[claimKey]) {
            if (params.detected.hasInvalidCanonical) {
              owner.close();
              return repairInvalidCanonicalIdentity(env, identityKey);
            }
            return {
              changes: [],
              warnings: [],
              notices: [
                "Retained legacy identity JSON is already consumed; local credentials remain authoritative.",
              ],
            };
          }
        } else if (readClientCredentialFileIdentity(resolveOpenClawStateSqlitePath(env))) {
          throw new Error(
            "Prepare the shared credential migration before importing legacy identities.",
          );
        }
        const snapshot = await readLegacyIdentitySource(params.stateDir, params.detected);
        if (!snapshot) {
          return { changes: [], warnings: [] };
        }
        let imported = false;
        owner.transaction(() => {
          if (!stored) {
            writeClientCredentialReceipt(
              owner.database,
              emptyClientCredentialReceipt(),
              "complete",
            );
          }
          const existing = readCanonicalIdentity(owner.database, identityKey);
          if (existing) {
            let valid: DeviceIdentity | undefined;
            try {
              valid = validateStoredDeviceIdentity(
                {
                  deviceId: existing.device_id,
                  publicKeyPem: existing.public_key_pem,
                  privateKeyPem: existing.private_key_pem,
                  createdAtMs: existing.created_at_ms,
                },
                identityKey,
              );
            } catch {
              /* Explicit Doctor repair below. */
            }
            if (!Number.isSafeInteger(existing.updated_at_ms) || existing.updated_at_ms < 0) {
              valid = undefined;
            }
            if (valid && !sameKeys(valid, snapshot.identity)) {
              throw new Error("Local client identity differs from the legacy identity.");
            }
            if (!valid) {
              executeSqliteQuerySync(
                owner.database,
                getNodeSqliteKysely<ClientCredentialDatabase>(owner.database)
                  .deleteFrom("device_identities")
                  .where("identity_key", "=", identityKey),
              );
            }
            imported = !valid;
          } else {
            imported = true;
          }
          importClientCredentialLegacy(owner, {
            key: claimKey,
            sha256: snapshot.sha256,
            identity: {
              identity_key: identityKey,
              device_id: snapshot.identity.deviceId,
              public_key_pem: snapshot.identity.publicKeyPem,
              private_key_pem: snapshot.identity.privateKeyPem,
              created_at_ms: snapshot.identity.createdAtMs,
              updated_at_ms: snapshot.identity.createdAtMs,
            },
          });
        });
        return {
          changes: [
            imported
              ? `Migrated ${identityKey} device identity to SQLite.`
              : `Preserved identical ${identityKey} device identity already in SQLite.`,
          ],
          warnings: [],
          notices: [
            "Legacy identity JSON was retained unchanged; its durable local claim prevents reimport.",
          ],
        };
      } finally {
        owner.close();
      }
    },
  });
}
