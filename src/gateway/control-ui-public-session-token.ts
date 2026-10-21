import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import { CONTROL_UI_PUBLIC_SESSION_SHARE_TOKEN_MAX_LENGTH } from "@openclaw/session-url-contract/public-share";
import {
  loadDeviceIdentityIfPresentAsync,
  loadOrCreateProcessDeviceIdentityAsync,
} from "../infra/device-identity-async.js";
import { resolveDeviceIdentityStore } from "../infra/device-identity-store.js";
import type { DeviceIdentity } from "../infra/device-identity.js";
import { deriveCanonicalEd25519PrivateKeyRaw } from "../infra/ed25519-signature.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { getOrCreateWeakOwnerMap } from "../shared/weak-owner-map.js";

const PUBLIC_SESSION_TOKEN_PREFIX = "v1.";
const PUBLIC_SESSION_TOKEN_CIPHER = "aes-256-gcm";
const PUBLIC_SESSION_TOKEN_NONCE_BYTES = 12;
const PUBLIC_SESSION_TOKEN_TAG_BYTES = 16;
const PUBLIC_SESSION_TOKEN_AAD = Buffer.from(
  "openclaw.public-session-share-locator.aad.v1",
  "utf8",
);
const PUBLIC_SESSION_WIDGET_TOKEN_AAD = Buffer.from(
  "openclaw.public-session-widget-locator.aad.v1",
  "utf8",
);
const PUBLIC_SESSION_TOKEN_KEY_SALT = Buffer.from(
  "openclaw.public-session-share-locator.salt.v1",
  "utf8",
);
const PUBLIC_SESSION_TOKEN_KEY_INFO = Buffer.from(
  "openclaw.public-session-share-locator.key.v1",
  "utf8",
);
const PUBLIC_SESSION_TOKEN_MAX_PLAINTEXT_BYTES = 5_000;
const PUBLIC_SESSION_TOKEN_CODEC_CACHE_LIMIT = 32;
const PUBLIC_SESSION_LOCATOR_KEYS = ["agentId", "sessionId", "sessionKey", "shareId"].toSorted();
const PUBLIC_SESSION_CLAIM_KEYS = [...PUBLIC_SESSION_LOCATOR_KEYS, "v"].toSorted();
const PUBLIC_SESSION_WIDGET_CLAIM_KEYS = [...PUBLIC_SESSION_CLAIM_KEYS, "doc"].toSorted();

export type PublicSessionShareLocator = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  shareId: string;
};

export type PublicSessionShareTokenCodec = {
  mint: (locator: PublicSessionShareLocator) => string;
  resolve: (token: string) => PublicSessionShareLocator | null;
};

type PublicSessionWidgetLocator = { locator: PublicSessionShareLocator; docId: string };
type PublicSessionTokenCodec = PublicSessionShareTokenCodec & {
  mintWidget: (locator: PublicSessionShareLocator, docId: string) => string;
  resolveWidget: (token: string) => PublicSessionWidgetLocator | null;
};

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join("\0") === keys.join("\0");
}

function isValidLocator(value: unknown): value is PublicSessionShareLocator {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.agentId === "string" &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value.agentId) &&
    typeof value.sessionKey === "string" &&
    value.sessionKey.length > 0 &&
    value.sessionKey.length <= 4_096 &&
    !containsAsciiControlCharacter(value.sessionKey) &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    value.sessionId.length <= 512 &&
    !/[/\\\s\p{Cc}]/u.test(value.sessionId) &&
    typeof value.shareId === "string" &&
    /^[a-f0-9]{48}$/u.test(value.shareId)
  );
}

function parseClaims(
  value: unknown,
  keys: readonly string[] = PUBLIC_SESSION_CLAIM_KEYS,
): PublicSessionShareLocator | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.v !== 1 || !hasExactKeys(value, keys) || !isValidLocator(value)) {
    return null;
  }
  return {
    agentId: value.agentId,
    sessionKey: value.sessionKey,
    sessionId: value.sessionId,
    shareId: value.shareId,
  };
}

function isValidWidgetDocumentId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    /^[A-Za-z0-9._-]+$/u.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function derivePublicSessionTokenKey(identity: DeviceIdentity): Buffer {
  const privateSeed = deriveCanonicalEd25519PrivateKeyRaw(identity.privateKeyPem);
  try {
    return Buffer.from(
      hkdfSync(
        "sha256",
        privateSeed,
        PUBLIC_SESSION_TOKEN_KEY_SALT,
        PUBLIC_SESSION_TOKEN_KEY_INFO,
        32,
      ),
    );
  } finally {
    privateSeed.fill(0);
  }
}

function encodePublicSessionLocator(locator: PublicSessionShareLocator, docId?: string): Buffer {
  if (!isValidLocator(locator) || !hasExactKeys(locator, PUBLIC_SESSION_LOCATOR_KEYS)) {
    throw new Error("invalid public session locator");
  }
  const claims = docId === undefined ? { v: 1, ...locator } : { v: 1, ...locator, doc: docId };
  const plaintext = Buffer.from(JSON.stringify(claims), "utf8");
  if (plaintext.byteLength > PUBLIC_SESSION_TOKEN_MAX_PLAINTEXT_BYTES) {
    throw new Error("public session locator exceeds the maximum length");
  }
  return plaintext;
}

/** Validate the exact encoded claims before a publication grant becomes durable. */
export function encodePublicSessionShareLocator(locator: PublicSessionShareLocator): Buffer {
  return encodePublicSessionLocator(locator);
}

/** Creates a domain-separated opaque-locator codec from one durable Gateway identity. */
function createPublicSessionShareTokenCodec(identity: DeviceIdentity): PublicSessionTokenCodec {
  const key = derivePublicSessionTokenKey(identity);
  function seal(plaintext: Buffer, aad: Buffer, locator: PublicSessionShareLocator): string {
    const nonce = randomBytes(PUBLIC_SESSION_TOKEN_NONCE_BYTES);
    const cipher = createCipheriv(PUBLIC_SESSION_TOKEN_CIPHER, key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const token = `${PUBLIC_SESSION_TOKEN_PREFIX}${Buffer.concat([
      nonce,
      cipher.getAuthTag(),
      ciphertext,
    ]).toString("base64url")}`;
    if (token.length > CONTROL_UI_PUBLIC_SESSION_SHARE_TOKEN_MAX_LENGTH) {
      throw new Error("public session token exceeds the maximum length");
    }
    registerSecretValueForRedaction(locator.shareId);
    registerSecretValueForRedaction(token);
    return token;
  }
  function open(token: string, aad: Buffer): unknown {
    if (
      token.length > CONTROL_UI_PUBLIC_SESSION_SHARE_TOKEN_MAX_LENGTH ||
      !token.startsWith(PUBLIC_SESSION_TOKEN_PREFIX)
    ) {
      return null;
    }
    const encoded = token.slice(PUBLIC_SESSION_TOKEN_PREFIX.length);
    if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
      return null;
    }
    const sealed = Buffer.from(encoded, "base64url");
    if (
      sealed.toString("base64url") !== encoded ||
      sealed.byteLength <= PUBLIC_SESSION_TOKEN_NONCE_BYTES + PUBLIC_SESSION_TOKEN_TAG_BYTES
    ) {
      return null;
    }
    const nonce = sealed.subarray(0, PUBLIC_SESSION_TOKEN_NONCE_BYTES);
    const tag = sealed.subarray(
      PUBLIC_SESSION_TOKEN_NONCE_BYTES,
      PUBLIC_SESSION_TOKEN_NONCE_BYTES + PUBLIC_SESSION_TOKEN_TAG_BYTES,
    );
    const ciphertext = sealed.subarray(
      PUBLIC_SESSION_TOKEN_NONCE_BYTES + PUBLIC_SESSION_TOKEN_TAG_BYTES,
    );
    if (ciphertext.byteLength > PUBLIC_SESSION_TOKEN_MAX_PLAINTEXT_BYTES) {
      return null;
    }
    try {
      const decipher = createDecipheriv(PUBLIC_SESSION_TOKEN_CIPHER, key, nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plaintext.byteLength > PUBLIC_SESSION_TOKEN_MAX_PLAINTEXT_BYTES) {
        return null;
      }
      return JSON.parse(plaintext.toString("utf8"));
    } catch {
      return null;
    }
  }
  return {
    mint: (locator) =>
      seal(encodePublicSessionShareLocator(locator), PUBLIC_SESSION_TOKEN_AAD, locator),
    resolve(token) {
      const locator = parseClaims(open(token, PUBLIC_SESSION_TOKEN_AAD));
      if (locator) {
        registerSecretValueForRedaction(token);
        registerSecretValueForRedaction(locator.shareId);
      }
      return locator;
    },
    mintWidget(locator, docId) {
      if (!isValidWidgetDocumentId(docId)) {
        throw new Error("invalid public session widget document");
      }
      return seal(
        encodePublicSessionLocator(locator, docId),
        PUBLIC_SESSION_WIDGET_TOKEN_AAD,
        locator,
      );
    },
    resolveWidget(token) {
      const claims = open(token, PUBLIC_SESSION_WIDGET_TOKEN_AAD);
      const locator = parseClaims(claims, PUBLIC_SESSION_WIDGET_CLAIM_KEYS);
      if (!locator || !isRecord(claims) || !isValidWidgetDocumentId(claims.doc)) {
        return null;
      }
      registerSecretValueForRedaction(token);
      registerSecretValueForRedaction(locator.shareId);
      return { locator, docId: claims.doc };
    },
  };
}

const codecsByDatabasePath = new Map<string, PublicSessionTokenCodec>();
const missingIdentityDatabasePaths = new Map<string, true>();
const previewTokens = new WeakMap<PublicSessionShareTokenCodec, Map<string, string>>();
const widgetTokens = new WeakMap<PublicSessionTokenCodec, Map<string, string>>();

function cacheCodec(databasePath: string, identity: DeviceIdentity): PublicSessionTokenCodec {
  const cached = codecsByDatabasePath.get(databasePath);
  if (cached) {
    return cached;
  }
  const codec = createPublicSessionShareTokenCodec(identity);
  pruneMapToMaxSize(codecsByDatabasePath, PUBLIC_SESSION_TOKEN_CODEC_CACHE_LIMIT - 1);
  codecsByDatabasePath.set(databasePath, codec);
  missingIdentityDatabasePaths.delete(databasePath);
  return codec;
}

function resolveProcessCodec(params: {
  create: boolean;
  env?: NodeJS.ProcessEnv;
}): PublicSessionTokenCodec | null | Promise<PublicSessionTokenCodec | null> {
  const options = params.env ? { env: params.env } : {};
  const { databasePath } = resolveDeviceIdentityStore(options);
  const cached = codecsByDatabasePath.get(databasePath);
  if (cached) {
    return cached;
  }
  if (!params.create && missingIdentityDatabasePaths.has(databasePath)) {
    return null;
  }
  const identity = params.create
    ? loadOrCreateProcessDeviceIdentityAsync({ ...options, path: databasePath })
    : loadDeviceIdentityIfPresentAsync({ ...options, path: databasePath });
  return identity.then((loaded) => {
    if (!loaded) {
      // Creation can finish while the read-only identity lookup is pending.
      const created = codecsByDatabasePath.get(databasePath);
      if (created) {
        return created;
      }
      pruneMapToMaxSize(missingIdentityDatabasePaths, PUBLIC_SESSION_TOKEN_CODEC_CACHE_LIMIT - 1);
      missingIdentityDatabasePaths.set(databasePath, true);
      return null;
    }
    return cacheCodec(databasePath, loaded);
  });
}

function requirePublicSessionShareTokenCodec(
  codec: PublicSessionShareTokenCodec | null,
): PublicSessionShareTokenCodec {
  if (!codec) {
    throw new Error("public session token identity is unavailable");
  }
  return codec;
}

/** Warm codecs remain synchronous so a prepared session row needs no new read phase. */
export function loadPublicSessionShareTokenCodec(
  options: { env?: NodeJS.ProcessEnv } = {},
): PublicSessionShareTokenCodec | Promise<PublicSessionShareTokenCodec> {
  const codec = resolveProcessCodec({
    create: true,
    ...(options.env ? { env: options.env } : {}),
  });
  return codec instanceof Promise
    ? codec.then(requirePublicSessionShareTokenCodec)
    : requirePublicSessionShareTokenCodec(codec);
}

/** Resolves an opaque locator without letting anonymous traffic create durable identity state. */
export async function resolvePublicSessionShareToken(
  token: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<PublicSessionShareLocator | null> {
  return (
    (
      await resolveProcessCodec({
        create: false,
        ...(options.env ? { env: options.env } : {}),
      })
    )?.resolve(token) ?? null
  );
}

/** Public readers may reuse the installation identity but must never create it. */
export async function mintExistingPublicSessionShareToken(
  locator: PublicSessionShareLocator,
): Promise<string | undefined> {
  const codec = await resolveProcessCodec({ create: false });
  if (!codec) {
    return undefined;
  }
  const tokens = getOrCreateWeakOwnerMap(previewTokens, codec);
  const key = JSON.stringify(locator);
  let token = tokens.get(key);
  if (!token) {
    token = codec.mint(locator);
    pruneMapToMaxSize(tokens, 127);
    tokens.set(key, token);
  }
  return token;
}

/** Widget frames carry only a document-scoped credential, never the publication bearer. */
export async function mintPublicSessionWidgetToken(
  locator: PublicSessionShareLocator,
  docId: string,
): Promise<string | undefined> {
  // Shortcode references are model-authored; an unmintable one omits its frame
  // instead of failing the whole public page.
  if (!isValidWidgetDocumentId(docId)) {
    return undefined;
  }
  const codec = await resolveProcessCodec({ create: false });
  if (!codec) {
    return undefined;
  }
  let tokens = widgetTokens.get(codec);
  if (!tokens) {
    tokens = new Map();
    widgetTokens.set(codec, tokens);
  }
  const key = JSON.stringify([
    Object.entries(locator).toSorted(([left], [right]) => left.localeCompare(right)),
    docId,
  ]);
  let token = tokens.get(key);
  if (!token) {
    token = codec.mintWidget(locator, docId);
    pruneMapToMaxSize(tokens, 127);
    tokens.set(key, token);
  }
  return token;
}

export async function resolvePublicSessionWidgetToken(
  token: string,
): Promise<PublicSessionWidgetLocator | null> {
  return (await resolveProcessCodec({ create: false }))?.resolveWidget(token) ?? null;
}
