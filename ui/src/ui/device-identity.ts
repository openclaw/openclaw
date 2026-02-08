/**
 * Device identity management using Web Crypto API.
 *
 * The Ed25519 private key is stored as a non-extractable CryptoKey in IndexedDB.
 * This prevents exfiltration of raw key material via XSS or malicious extensions —
 * the key can be *used* for signing within the origin but its bytes cannot be read.
 *
 * Legacy identities (v1, plaintext in localStorage) are migrated on first load
 * and the plaintext is deleted.
 */

const DB_NAME = "openclaw-device-identity";
const DB_VERSION = 1;
const STORE_NAME = "keys";
const IDENTITY_KEY = "current";
const LEGACY_STORAGE_KEY = "openclaw-device-identity-v1";

type StoredEntry = {
  id: string;
  deviceId: string;
  publicKey: string;
  privateKey: CryptoKey;
  createdAtMs: number;
};

export type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: CryptoKey;
};

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fingerprintPublicKey(publicKey: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", publicKey.slice().buffer);
  return bytesToHex(new Uint8Array(hash));
}

// --- IndexedDB helpers ---

function openIdentityDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.addEventListener("error", () => reject(req.error));
  });
}

function dbGet(db: IDBDatabase): Promise<StoredEntry | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(IDENTITY_KEY);
    req.onsuccess = () => resolve(req.result as StoredEntry | undefined);
    req.addEventListener("error", () => reject(req.error));
  });
}

function dbPut(db: IDBDatabase, entry: StoredEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const req = tx.objectStore(STORE_NAME).put(entry);
    req.onsuccess = () => resolve();
    req.addEventListener("error", () => reject(req.error));
  });
}

// --- Legacy migration ---

async function migrateLegacyKey(db: IDBDatabase): Promise<DeviceIdentity | null> {
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw) as {
    version?: number;
    privateKey?: string;
    publicKey?: string;
    createdAtMs?: number;
  };
  if (parsed?.version !== 1 || !parsed.privateKey || !parsed.publicKey) {
    return null;
  }

  // Import the raw seed as a non-extractable CryptoKey via JWK.
  // The legacy privateKey and publicKey are already base64url-encoded without padding,
  // which matches the JWK "d" and "x" fields for Ed25519.
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", d: parsed.privateKey, x: parsed.publicKey },
    "Ed25519",
    false,
    ["sign"],
  );

  const publicKeyBytes = Uint8Array.from(
    atob(parsed.publicKey.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
  const deviceId = await fingerprintPublicKey(publicKeyBytes);

  await dbPut(db, {
    id: IDENTITY_KEY,
    deviceId,
    publicKey: parsed.publicKey,
    privateKey,
    createdAtMs: parsed.createdAtMs ?? Date.now(),
  });

  // Remove plaintext private key from localStorage
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  return { deviceId, publicKey: parsed.publicKey, privateKey };
}

// --- Key generation ---

async function generateIdentity(): Promise<DeviceIdentity> {
  const keyPair = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"]);
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const deviceId = await fingerprintPublicKey(publicKeyRaw);
  return {
    deviceId,
    publicKey: base64UrlEncode(publicKeyRaw),
    privateKey: keyPair.privateKey,
  };
}

// --- Public API ---

export async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  let db: IDBDatabase;
  try {
    db = await openIdentityDB();
  } catch {
    // IndexedDB unavailable (e.g. certain privacy modes); ephemeral identity
    return generateIdentity();
  }

  try {
    const entry = await dbGet(db);
    if (entry?.privateKey && entry.publicKey && entry.deviceId) {
      return { deviceId: entry.deviceId, publicKey: entry.publicKey, privateKey: entry.privateKey };
    }

    try {
      const migrated = await migrateLegacyKey(db);
      if (migrated) {
        return migrated;
      }
    } catch {
      // Migration failed (corrupt data, etc.); generate fresh identity
    }

    const identity = await generateIdentity();
    await dbPut(db, {
      id: IDENTITY_KEY,
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
      createdAtMs: Date.now(),
    });
    return identity;
  } finally {
    db.close();
  }
}

export async function signDevicePayload(privateKey: CryptoKey, payload: string) {
  const data = new TextEncoder().encode(payload);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, data));
  return base64UrlEncode(sig);
}
