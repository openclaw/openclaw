import { randomBytes, createCipheriv, createDecipheriv, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SEALED_JSON_PREFIX = "openclaw-sealed-json-v1:";

type SealedJsonEnvelope = {
  v: 1;
  alg: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

export class SealedJsonPassphraseRequiredError extends Error {
  constructor(pathname: string) {
    super(
      `Encrypted OpenClaw auth store at ${pathname} requires OPENCLAW_PASSPHRASE to be set before it can be read.`,
    );
    this.name = "SealedJsonPassphraseRequiredError";
  }
}

function resolvePassphrase(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.OPENCLAW_PASSPHRASE?.trim();
  return value ? value : null;
}

function toBase64(value: Buffer): string {
  return value.toString("base64");
}

function fromBase64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32);
}

function sealUtf8(plaintext: string, passphrase: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: SealedJsonEnvelope = {
    v: 1,
    alg: "aes-256-gcm",
    salt: toBase64(salt),
    iv: toBase64(iv),
    tag: toBase64(cipher.getAuthTag()),
    ciphertext: toBase64(ciphertext),
  };
  return `${SEALED_JSON_PREFIX}${JSON.stringify(envelope)}\n`;
}

function unsealUtf8(raw: string, passphrase: string): string {
  if (!raw.startsWith(SEALED_JSON_PREFIX)) {
    return raw;
  }
  const payload = raw.slice(SEALED_JSON_PREFIX.length).trim();
  const envelope = JSON.parse(payload) as Partial<SealedJsonEnvelope>;
  if (
    envelope.v !== 1 ||
    envelope.alg !== "aes-256-gcm" ||
    typeof envelope.salt !== "string" ||
    typeof envelope.iv !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("invalid sealed json envelope");
  }
  const key = deriveKey(passphrase, fromBase64(envelope.salt));
  const decipher = createDecipheriv("aes-256-gcm", key, fromBase64(envelope.iv));
  decipher.setAuthTag(fromBase64(envelope.tag));
  return Buffer.concat([
    decipher.update(fromBase64(envelope.ciphertext)),
    decipher.final(),
  ]).toString("utf8");
}

export function loadSealedJsonFile(
  pathname: string,
  env: NodeJS.ProcessEnv = process.env,
): unknown {
  if (!fs.existsSync(pathname)) {
    return undefined;
  }
  const raw = fs.readFileSync(pathname, "utf8");
  if (!raw.startsWith(SEALED_JSON_PREFIX)) {
    return JSON.parse(raw) as unknown;
  }
  const passphrase = resolvePassphrase(env);
  if (!passphrase) {
    throw new SealedJsonPassphraseRequiredError(pathname);
  }
  return JSON.parse(unsealUtf8(raw, passphrase)) as unknown;
}

export function saveSealedJsonFile(
  pathname: string,
  data: unknown,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const plaintext = `${JSON.stringify(data, null, 2)}\n`;
  const passphrase = resolvePassphrase(env);
  fs.writeFileSync(pathname, passphrase ? sealUtf8(plaintext, passphrase) : plaintext, "utf8");
  fs.chmodSync(pathname, 0o600);
}

export function isSealedJsonText(raw: string): boolean {
  return raw.startsWith(SEALED_JSON_PREFIX);
}
