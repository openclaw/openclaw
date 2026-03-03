import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OperatorScope } from "./method-scopes.js";
import type { GatewayRole } from "./role-policy.js";

const SCOPED_TOKEN_PREFIX = "osc_";
const TOKEN_VERSION = 1;
const JTI_LENGTH = 21;

export type ScopedTokenPayload = {
  v: 1;
  jti: string;
  sub: string;
  role: GatewayRole;
  scopes: OperatorScope[];
  methods?: string[];
  iat: number;
  exp?: number;
  nbf?: number;
};

export type ScopedTokenValidationResult =
  | { valid: true; payload: ScopedTokenPayload }
  | {
      valid: false;
      reason: "malformed" | "bad-signature" | "expired" | "not-yet-valid" | "revoked";
    };

// -- Base64url helpers (no padding) --

function base64urlEncode(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return buf.toString("base64url");
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

// -- Signing key management --

export function generateSigningKey(): Buffer {
  return randomBytes(32);
}

export function loadOrCreateSigningKey(keyPath: string): Buffer {
  const dir = path.dirname(keyPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  if (fs.existsSync(keyPath)) {
    const key = fs.readFileSync(keyPath);
    if (key.length < 32) {
      throw new Error(`signing key at ${keyPath} is too short (${key.length} bytes, need 32)`);
    }
    return key;
  }

  const key = generateSigningKey();
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}

// -- Nanoid-style ID generation --

function generateJti(): string {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-";
  const bytes = randomBytes(JTI_LENGTH);
  let id = "";
  for (let i = 0; i < JTI_LENGTH; i++) {
    id += alphabet[bytes[i] % alphabet.length];
  }
  return id;
}

// -- HMAC signing --

function signPayload(payloadB64: string, signingKey: Buffer): string {
  const mac = createHmac("sha256", signingKey).update(payloadB64).digest();
  return base64urlEncode(mac);
}

// -- Token operations --

export function createScopedToken(params: {
  signingKey: Buffer;
  subject: string;
  role: GatewayRole;
  scopes: OperatorScope[];
  methods?: string[];
  ttlSeconds?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: ScopedTokenPayload = {
    v: TOKEN_VERSION,
    jti: generateJti(),
    sub: params.subject,
    role: params.role,
    scopes: params.scopes,
    iat: now,
  };
  if (params.methods && params.methods.length > 0) {
    payload.methods = params.methods;
  }
  if (params.ttlSeconds !== undefined && params.ttlSeconds > 0) {
    payload.exp = now + params.ttlSeconds;
  }

  const payloadJson = JSON.stringify(payload);
  const payloadB64 = base64urlEncode(payloadJson);
  const sig = signPayload(payloadB64, params.signingKey);
  return `${SCOPED_TOKEN_PREFIX}${payloadB64}.${sig}`;
}

export function isScopedToken(token: string): boolean {
  return token.startsWith(SCOPED_TOKEN_PREFIX);
}

export function parseScopedToken(token: string): ScopedTokenPayload | null {
  if (!isScopedToken(token)) {
    return null;
  }

  const body = token.slice(SCOPED_TOKEN_PREFIX.length);
  const dotIndex = body.indexOf(".");
  if (dotIndex < 0) {
    return null;
  }

  const payloadB64 = body.slice(0, dotIndex);
  try {
    const json = base64urlDecode(payloadB64).toString("utf8");
    const parsed = JSON.parse(json) as Record<string, unknown>;

    if (parsed.v !== TOKEN_VERSION) {
      return null;
    }
    if (typeof parsed.jti !== "string" || parsed.jti.length === 0) {
      return null;
    }
    if (typeof parsed.sub !== "string") {
      return null;
    }
    if (parsed.role !== "operator" && parsed.role !== "node") {
      return null;
    }
    if (!Array.isArray(parsed.scopes)) {
      return null;
    }
    if (typeof parsed.iat !== "number") {
      return null;
    }

    return parsed as unknown as ScopedTokenPayload;
  } catch {
    return null;
  }
}

export function validateScopedToken(params: {
  token: string;
  signingKey: Buffer;
  now?: number;
}): ScopedTokenValidationResult {
  if (!isScopedToken(params.token)) {
    return { valid: false, reason: "malformed" };
  }

  const body = params.token.slice(SCOPED_TOKEN_PREFIX.length);
  const dotIndex = body.indexOf(".");
  if (dotIndex < 0) {
    return { valid: false, reason: "malformed" };
  }

  const payloadB64 = body.slice(0, dotIndex);
  const providedSig = body.slice(dotIndex + 1);

  // Verify signature using timing-safe comparison
  const expectedSig = signPayload(payloadB64, params.signingKey);
  const sigBuf = Buffer.from(providedSig, "base64url");
  const expectedBuf = Buffer.from(expectedSig, "base64url");
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, reason: "bad-signature" };
  }

  const payload = parseScopedToken(params.token);
  if (!payload) {
    return { valid: false, reason: "malformed" };
  }

  const now = params.now ?? Math.floor(Date.now() / 1000);

  if (payload.exp !== undefined && now >= payload.exp) {
    return { valid: false, reason: "expired" };
  }

  if (payload.nbf !== undefined && now < payload.nbf) {
    return { valid: false, reason: "not-yet-valid" };
  }

  return { valid: true, payload };
}
