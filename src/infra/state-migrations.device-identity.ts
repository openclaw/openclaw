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
} from "./client-credential-receipt.js";
import type { ClientCredentialDatabase } from "./client-credential-schema.js";
import { openClientCredentialCustody } from "./client-credential-store.js";
import { normalizeLegacyDeviceIdentity } from "./device-identity-legacy.js";
import { validateStoredDeviceIdentity, type DeviceIdentity } from "./device-identity-store.js";
import { deriveEd25519PrivateKeyRaw, deriveEd25519PublicKeyRaw } from "./ed25519-signature.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import {
  hasLegacyDeviceIdentityPath,
  repairInvalidCanonicalIdentity,
} from "./state-migrations.device-identity-repair.js";
import type { LegacyDeviceIdentityDetection } from "./state-migrations.device-identity.types.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import { readLegacyMigrationSourceSnapshot } from "./state-migrations.source-snapshot.js";
import type { MigrationMessages } from "./state-migrations.types.js";

export { detectLegacyDeviceIdentity } from "./state-migrations.device-identity-repair.js";
const IDENTITY_KEY = "primary";
const MAX_BYTES = 128 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

function readCanonicalIdentity(db: DatabaseSync) {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<Pick<ClientCredentialDatabase, "device_identities">>(db)
      .selectFrom("device_identities")
      .selectAll()
      .where("identity_key", "=", IDENTITY_KEY),
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

/** Copy-only import: retained JSON never becomes authoritative after its durable claim. */
export async function migrateLegacyDeviceIdentity(params: {
  detected: LegacyDeviceIdentityDetection;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  doctorOnlyStateMigrations?: boolean;
}): Promise<MigrationMessages> {
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
          ? repairInvalidCanonicalIdentity(env)
          : { changes: [], warnings: [] };
      }
      const owner = openClientCredentialCustody(env, { createIfMissing: true, migration: true });
      if (!owner) {
        throw new Error("Local client credentials are unavailable.");
      }
      try {
        const stored = readClientCredentialReceipt(owner.database);
        if (stored) {
          assertClientCredentialStoreReady(owner.database, env, false);
          if (stored.receipt.legacyImports["identity:primary"]) {
            if (params.detected.hasInvalidCanonical) {
              owner.close();
              return repairInvalidCanonicalIdentity(env);
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
        const stateRoot = await root(params.stateDir, {
          hardlinks: "reject",
          maxBytes: MAX_BYTES,
          symlinks: "reject",
        });
        const candidates = [
          params.detected.sourcePath,
          params.detected.claimPath,
          params.detected.nativeClaimPath,
        ];
        const snapshots = [];
        for (const sourcePath of candidates) {
          if (await stateRoot.exists(sourcePath.slice(params.stateDir.length + 1))) {
            snapshots.push(await readSource(stateRoot, params.stateDir, sourcePath));
          }
        }
        const snapshot = snapshots[0];
        if (!snapshot) {
          return { changes: [], warnings: [] };
        }
        if (snapshots.some((other) => other.sha256 !== snapshot.sha256)) {
          throw new Error(
            "Legacy identity files disagree; preserve them and resolve the conflict before importing.",
          );
        }
        let imported = false;
        runSqliteImmediateTransactionSync(owner.database, () => {
          if (!stored) {
            writeClientCredentialReceipt(
              owner.database,
              emptyClientCredentialReceipt(),
              "complete",
            );
          }
          const existing = readCanonicalIdentity(owner.database);
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
                IDENTITY_KEY,
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
                  .where("identity_key", "=", IDENTITY_KEY),
              );
            }
            imported = !valid;
          } else {
            imported = true;
          }
          importClientCredentialLegacy(owner, {
            key: "identity:primary",
            sha256: snapshot.sha256,
            identity: {
              identity_key: IDENTITY_KEY,
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
              ? "Migrated primary device identity to SQLite."
              : "Preserved identical primary device identity already in SQLite.",
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
