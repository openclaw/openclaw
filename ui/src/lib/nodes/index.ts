import { getPublicKeyAsync, hashes, signAsync, utils } from "@noble/ed25519";
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import {
  type DeviceAuthEntry,
  type DeviceAuthStore,
  normalizeDeviceAuthRole,
  normalizeDeviceAuthScopes,
} from "../../../../src/shared/device-auth.js";
import { getSafeLocalStorage } from "../../local-storage.ts";

export type {
  DevicePairingList,
  DeviceTokenSummary,
  PairedDevice,
  PendingDevice,
} from "../../../../src/gateway/device-pairing-list.types.js";

// @noble/ed25519 defaults its SHA-512 to crypto.subtle, which browsers gate to
// secure contexts. On plain-HTTP origins the pure-JS digests load lazily so
// device identity keeps working there — the signing key is the one credential
// that never crosses the wire — while secure contexts pay no startup bytes.
const loadPureSha2 = () => import("@noble/hashes/sha2.js");
const subtleSha512Async = hashes.sha512Async;
hashes.sha512Async = async (message: Uint8Array) => {
  if (globalThis.crypto?.subtle && subtleSha512Async) {
    return await subtleSha512Async(message);
  }
  return Uint8Array.from((await loadPureSha2()).sha512(message));
};

type StoredIdentity = {
  version: 1;
  deviceId: string;
  publicKey: string;
  privateKey: string;
  createdAtMs: number;
};

type DeviceIdentity = {
  deviceId: string;
  publicKey: string;
  privateKey: string;
};

const LEGACY_DEVICE_AUTH_STORAGE_KEY = "openclaw.device.auth.v1";
const DEVICE_AUTH_STORAGE_KEY_PREFIX = `${LEGACY_DEVICE_AUTH_STORAGE_KEY}:`;
const DEVICE_IDENTITY_STORAGE_KEY = "openclaw-device-identity-v1";

function deviceAuthStorageKey(gatewayUrl: string): string {
  return `${DEVICE_AUTH_STORAGE_KEY_PREFIX}${gatewayCredentialScope(gatewayUrl)}`;
}

function removeLegacyDeviceAuthStore(storage: Storage | null) {
  try {
    storage?.removeItem(LEGACY_DEVICE_AUTH_STORAGE_KEY);
  } catch {
    // Legacy cleanup must not make an otherwise usable device token unreadable.
  }
}

function parseDeviceAuthStore(raw: string | null): DeviceAuthStore | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as DeviceAuthStore;
    if (!parsed || parsed.version !== 1) {
      return null;
    }
    if (!parsed.deviceId || typeof parsed.deviceId !== "string") {
      return null;
    }
    if (!parsed.tokens || typeof parsed.tokens !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function readStore(gatewayUrl: string): DeviceAuthStore | null {
  try {
    const storage = getSafeLocalStorage();
    const scopedKey = deviceAuthStorageKey(gatewayUrl);
    const scopedStore = parseDeviceAuthStore(storage?.getItem(scopedKey) ?? null);
    if (scopedStore) {
      removeLegacyDeviceAuthStore(storage);
      return scopedStore;
    }

    const legacyStore = parseDeviceAuthStore(
      storage?.getItem(LEGACY_DEVICE_AUTH_STORAGE_KEY) ?? null,
    );
    if (!legacyStore) {
      return null;
    }

    // Older releases stored one origin-wide token. Claim it for the first gateway
    // opened after upgrade, then remove the ambiguous key before sibling routes use it.
    try {
      storage?.setItem(scopedKey, JSON.stringify(legacyStore));
      removeLegacyDeviceAuthStore(storage);
    } catch {
      // Keep the usable in-memory result when browser storage rejects the migration.
    }
    return legacyStore;
  } catch {
    return null;
  }
}

function writeStore(gatewayUrl: string, store: DeviceAuthStore) {
  try {
    const storage = getSafeLocalStorage();
    storage?.setItem(deviceAuthStorageKey(gatewayUrl), JSON.stringify(store));
    removeLegacyDeviceAuthStore(storage);
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

function canonicalDeviceAuthTokens(tokens: DeviceAuthStore["tokens"]) {
  const canonical: DeviceAuthStore["tokens"] = {};
  for (const [rawRole, entry] of Object.entries(tokens)) {
    const role = normalizeDeviceAuthRole(rawRole);
    if (!role || !entry || typeof entry.token !== "string") {
      continue;
    }
    canonical[role] = {
      token: entry.token,
      role,
      scopes: normalizeDeviceAuthScopes(Array.isArray(entry.scopes) ? entry.scopes : undefined),
      updatedAtMs: Number.isFinite(entry.updatedAtMs) ? entry.updatedAtMs : 0,
    };
  }
  return canonical;
}

export function loadDeviceAuthToken(params: {
  deviceId: string;
  gatewayUrl: string;
  role: string;
}): DeviceAuthEntry | null {
  const store = readStore(params.gatewayUrl);
  if (!store || store.deviceId !== params.deviceId) {
    return null;
  }
  const role = normalizeDeviceAuthRole(params.role);
  return canonicalDeviceAuthTokens(store.tokens)[role] ?? null;
}

export function loadCurrentDeviceAuthToken(gatewayUrl: string): string | null {
  const identity = readStoredDeviceIdentity(getSafeLocalStorage());
  if (!identity) {
    return null;
  }
  const entry = loadDeviceAuthToken({
    deviceId: identity.deviceId,
    gatewayUrl,
    role: "operator",
  });
  return entry?.scopes.includes("operator.read") ? entry.token : null;
}

export function storeDeviceAuthToken(params: {
  deviceId: string;
  gatewayUrl: string;
  role: string;
  token: string;
  scopes?: string[];
}): DeviceAuthEntry {
  const existing = readStore(params.gatewayUrl);
  const role = normalizeDeviceAuthRole(params.role);
  const entry: DeviceAuthEntry = {
    token: params.token,
    role,
    scopes: normalizeDeviceAuthScopes(params.scopes),
    updatedAtMs: Date.now(),
  };
  writeStore(params.gatewayUrl, {
    version: 1,
    deviceId: params.deviceId,
    tokens: {
      ...(existing?.deviceId === params.deviceId ? canonicalDeviceAuthTokens(existing.tokens) : {}),
      [role]: entry,
    },
  });
  return entry;
}

export function clearDeviceAuthToken(params: {
  deviceId: string;
  gatewayUrl: string;
  role: string;
}) {
  const store = readStore(params.gatewayUrl);
  if (!store || store.deviceId !== params.deviceId) {
    return;
  }
  const role = normalizeDeviceAuthRole(params.role);
  if (!store.tokens[role]) {
    return;
  }
  const tokens = canonicalDeviceAuthTokens(store.tokens);
  delete tokens[role];
  writeStore(params.gatewayUrl, { ...store, tokens });
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fingerprintPublicKey(publicKey: Uint8Array): Promise<string> {
  // Prefer the platform digest where the context provides it; the pure-JS
  // fallback keeps identity working on plain-HTTP origins without subtle.
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const hash = await subtle.digest("SHA-256", publicKey.slice().buffer);
    return bytesToHex(new Uint8Array(hash));
  }
  return bytesToHex((await loadPureSha2()).sha256(publicKey));
}

async function generateIdentity(): Promise<DeviceIdentity> {
  const privateKey = utils.randomSecretKey();
  const publicKey = await getPublicKeyAsync(privateKey);
  const deviceId = await fingerprintPublicKey(publicKey);
  return {
    deviceId,
    publicKey: base64UrlEncode(publicKey),
    privateKey: base64UrlEncode(privateKey),
  };
}

// Storage-blocked pages (for example private browsing) must still present one
// stable device per page lifetime; minting a fresh key on every reconnect
// would raise a new unpaired request each time and never retain approval.
let sessionDeviceIdentity: DeviceIdentity | null = null;

function readStoredDeviceIdentity(storage: Storage | null): StoredIdentity | null {
  try {
    const raw = storage?.getItem(DEVICE_IDENTITY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredIdentity;
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKey === "string" &&
        typeof parsed.privateKey === "string"
      ) {
        return parsed;
      }
    }
  } catch {
    // Unavailable or malformed browser storage carries no usable identity.
  }
  return null;
}

export async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  const storage = getSafeLocalStorage();
  const parsed = readStoredDeviceIdentity(storage);
  try {
    if (parsed) {
      const derivedId = await fingerprintPublicKey(base64UrlDecode(parsed.publicKey));
      if (derivedId !== parsed.deviceId) {
        const updated: StoredIdentity = {
          ...parsed,
          deviceId: derivedId,
        };
        storage?.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(updated));
        return {
          deviceId: derivedId,
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey,
        };
      }
      return {
        deviceId: parsed.deviceId,
        publicKey: parsed.publicKey,
        privateKey: parsed.privateKey,
      };
    }
  } catch {
    // Invalid local identity is replaced below.
  }

  if (sessionDeviceIdentity) {
    return sessionDeviceIdentity;
  }
  const identity = await generateIdentity();
  const stored: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    createdAtMs: Date.now(),
  };
  try {
    storage?.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // A write-rejecting store still gets the in-memory identity below.
  }
  sessionDeviceIdentity = identity;
  return identity;
}

export async function signDevicePayload(privateKeyBase64Url: string, payload: string) {
  const key = base64UrlDecode(privateKeyBase64Url);
  const data = new TextEncoder().encode(payload);
  const sig = await signAsync(data, key);
  return base64UrlEncode(sig);
}
