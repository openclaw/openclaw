import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Insertable, Selectable } from "kysely";
import { resolveStateDir } from "../config/paths.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

export type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

export type StoredDeviceIdentity = {
  version: 1;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
};

const DEVICE_IDENTITY_KEY = "default";

type DeviceIdentityDatabase = Pick<OpenClawStateKyselyDatabase, "device_identities">;
type DeviceIdentityRow = Selectable<DeviceIdentityDatabase["device_identities"]>;
type DeviceIdentityInsert = Insertable<DeviceIdentityDatabase["device_identities"]>;

export type DeviceIdentityStoreOptions = {
  env?: NodeJS.ProcessEnv;
  key?: string;
  checkLegacyIdentity?: boolean;
};

export class DeviceIdentityMigrationRequiredError extends Error {
  constructor(filePath: string) {
    super(
      `Legacy device identity exists at ${filePath} but has not been imported into SQLite. Run "openclaw doctor --fix" before starting the gateway or connecting this client.`,
    );
    this.name = "DeviceIdentityMigrationRequiredError";
  }
}

export class DeviceIdentityStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceIdentityStorageError";
  }
}

function normalizeIdentityStoreOptions(
  options: DeviceIdentityStoreOptions = {},
): Required<Pick<DeviceIdentityStoreOptions, "env" | "key" | "checkLegacyIdentity">> {
  const env = options.env ?? process.env;
  const key = options.key?.trim() || DEVICE_IDENTITY_KEY;
  return {
    env,
    key,
    checkLegacyIdentity: options.checkLegacyIdentity ?? key === DEVICE_IDENTITY_KEY,
  };
}

function resolveLegacyIdentityPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), "identity", "device.json");
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const deviceId = fingerprintPublicKey(publicKeyPem);
  return { deviceId, publicKeyPem, privateKeyPem };
}

function parseStoredIdentity(value: unknown): StoredDeviceIdentity | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { deviceId?: unknown }).deviceId !== "string" ||
    typeof (value as { publicKeyPem?: unknown }).publicKeyPem !== "string" ||
    typeof (value as { privateKeyPem?: unknown }).privateKeyPem !== "string"
  ) {
    return null;
  }
  return value as StoredDeviceIdentity;
}

function rowToStoredIdentity(row: DeviceIdentityRow): StoredDeviceIdentity {
  return {
    version: 1,
    deviceId: row.device_id,
    publicKeyPem: row.public_key_pem,
    privateKeyPem: row.private_key_pem,
    createdAtMs: row.created_at_ms,
  };
}

function storedIdentityToRow(
  key: string,
  stored: StoredDeviceIdentity,
  updatedAtMs: number,
): DeviceIdentityInsert {
  return {
    identity_key: key,
    device_id: stored.deviceId,
    public_key_pem: stored.publicKeyPem,
    private_key_pem: stored.privateKeyPem,
    created_at_ms: stored.createdAtMs,
    updated_at_ms: updatedAtMs,
  };
}

function deriveStoredDeviceIdOrThrow(stored: StoredDeviceIdentity): string {
  const derivedId = deriveDeviceIdFromPublicKey(stored.publicKeyPem);
  if (!derivedId) {
    throw new DeviceIdentityStorageError(
      'Stored device identity is invalid. Run "openclaw doctor --fix" before starting the gateway or connecting this client.',
    );
  }
  return derivedId;
}

function readStoredIdentity(options?: DeviceIdentityStoreOptions): StoredDeviceIdentity | null {
  const store = normalizeIdentityStoreOptions(options);
  const database = openOpenClawStateDatabase({ env: store.env });
  const db = getNodeSqliteKysely<DeviceIdentityDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("device_identities").selectAll().where("identity_key", "=", store.key),
  );
  if (!row) {
    return null;
  }
  const parsed = parseStoredIdentity(rowToStoredIdentity(row));
  if (!parsed) {
    throw new DeviceIdentityStorageError(
      'Stored device identity is invalid. Run "openclaw doctor --fix" before starting the gateway or connecting this client.',
    );
  }
  return parsed;
}

function legacyIdentityFileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function assertNoUnimportedLegacyIdentity(filePath: string): void {
  if (legacyIdentityFileExists(filePath)) {
    throw new DeviceIdentityMigrationRequiredError(filePath);
  }
}

function writeStoredIdentity(
  stored: StoredDeviceIdentity,
  options?: DeviceIdentityStoreOptions,
): void {
  const store = normalizeIdentityStoreOptions(options);
  const row = storedIdentityToRow(store.key, stored, Date.now());
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<DeviceIdentityDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("device_identities")
          .values(row)
          .onConflict((conflict) =>
            conflict.column("identity_key").doUpdateSet({
              device_id: row.device_id,
              public_key_pem: row.public_key_pem,
              private_key_pem: row.private_key_pem,
              created_at_ms: row.created_at_ms,
              updated_at_ms: row.updated_at_ms,
            }),
          ),
      );
    },
    { env: store.env },
  );
}

export function loadOrCreateDeviceIdentity(options?: DeviceIdentityStoreOptions): DeviceIdentity {
  const store = normalizeIdentityStoreOptions(options);
  const parsed = readStoredIdentity(store);
  if (parsed) {
    const derivedId = deriveStoredDeviceIdOrThrow(parsed);
    if (derivedId && derivedId !== parsed.deviceId) {
      const updated: StoredDeviceIdentity = {
        ...parsed,
        deviceId: derivedId,
      };
      writeStoredIdentity(updated, store);
      return {
        deviceId: derivedId,
        publicKeyPem: parsed.publicKeyPem,
        privateKeyPem: parsed.privateKeyPem,
      };
    }
    return {
      deviceId: parsed.deviceId,
      publicKeyPem: parsed.publicKeyPem,
      privateKeyPem: parsed.privateKeyPem,
    };
  }

  if (store.checkLegacyIdentity) {
    assertNoUnimportedLegacyIdentity(resolveLegacyIdentityPath(store.env));
  }

  const identity = generateIdentity();
  const stored: StoredDeviceIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  writeStoredIdentity(stored, store);
  return identity;
}

export function loadDeviceIdentityIfPresent(
  options?: DeviceIdentityStoreOptions,
): DeviceIdentity | null {
  try {
    const parsed = readStoredIdentity(options);
    if (!parsed) {
      return null;
    }
    const derivedId = deriveDeviceIdFromPublicKey(parsed.publicKeyPem);
    if (!derivedId || derivedId !== parsed.deviceId) {
      return null;
    }
    return {
      deviceId: parsed.deviceId,
      publicKeyPem: parsed.publicKeyPem,
      privateKeyPem: parsed.privateKeyPem,
    };
  } catch {
    return null;
  }
}

export function loadDeviceIdentityIfPresentForEnv(
  env: NodeJS.ProcessEnv = process.env,
): DeviceIdentity | null {
  return loadDeviceIdentityIfPresent({ env });
}

export function parseStoredDeviceIdentitySnapshot(value: unknown): StoredDeviceIdentity | null {
  return parseStoredIdentity(value);
}

export function writeStoredDeviceIdentitySnapshot(
  stored: StoredDeviceIdentity,
  options?: DeviceIdentityStoreOptions,
): void {
  writeStoredIdentity(stored, options);
}

export function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

export function normalizeDevicePublicKeyBase64Url(publicKey: string): string | null {
  try {
    if (publicKey.includes("BEGIN")) {
      return base64UrlEncode(derivePublicKeyRaw(publicKey));
    }
    const raw = base64UrlDecode(publicKey);
    if (raw.length === 0) {
      return null;
    }
    return base64UrlEncode(raw);
  } catch {
    return null;
  }
}

export function deriveDeviceIdFromPublicKey(publicKey: string): string | null {
  try {
    const raw = publicKey.includes("BEGIN")
      ? derivePublicKeyRaw(publicKey)
      : base64UrlDecode(publicKey);
    if (raw.length === 0) {
      return null;
    }
    return crypto.createHash("sha256").update(raw).digest("hex");
  } catch {
    return null;
  }
}

export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

export function verifyDeviceSignature(
  publicKey: string,
  payload: string,
  signatureBase64Url: string,
): boolean {
  try {
    const key = publicKey.includes("BEGIN")
      ? crypto.createPublicKey(publicKey)
      : crypto.createPublicKey({
          key: Buffer.concat([ED25519_SPKI_PREFIX, base64UrlDecode(publicKey)]),
          type: "spki",
          format: "der",
        });
    const sig = (() => {
      try {
        return base64UrlDecode(signatureBase64Url);
      } catch {
        return Buffer.from(signatureBase64Url, "base64");
      }
    })();
    return crypto.verify(null, Buffer.from(payload, "utf8"), key, sig);
  } catch {
    return false;
  }
}
