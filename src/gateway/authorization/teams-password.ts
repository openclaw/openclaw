import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const MIN_PASSWORD_BYTES = 8;
const MAX_PASSWORD_BYTES = 1_024;
const DUMMY_SALT = Buffer.alloc(SALT_LENGTH, 0xa5);
const DUMMY_VERIFIER = Buffer.alloc(KEY_LENGTH, 0x5a);

export const TEAMS_PASSWORD_SCRYPT = Object.freeze({
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
});

export type TeamsPasswordCredential = Readonly<{
  salt: Uint8Array;
  verifier: Uint8Array;
  n: number;
  r: number;
  p: number;
}>;

export function normalizeTeamsLoginLabel(value: string): string {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (!normalized || normalized.length > 254) {
    throw new Error("login label must contain between 1 and 254 characters");
  }
  return normalized;
}

function validatePassword(password: string): void {
  const byteLength = Buffer.byteLength(password, "utf8");
  if (byteLength < MIN_PASSWORD_BYTES || byteLength > MAX_PASSWORD_BYTES) {
    throw new Error(
      `password must contain between ${MIN_PASSWORD_BYTES} and ${MAX_PASSWORD_BYTES} UTF-8 bytes`,
    );
  }
}

function derive(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, TEAMS_PASSWORD_SCRYPT, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

export async function prepareTeamsPassword(password: string): Promise<TeamsPasswordCredential> {
  validatePassword(password);
  const salt = randomBytes(SALT_LENGTH);
  const verifier = await derive(password, salt);
  return Object.freeze({
    salt,
    verifier,
    n: TEAMS_PASSWORD_SCRYPT.N,
    r: TEAMS_PASSWORD_SCRYPT.r,
    p: TEAMS_PASSWORD_SCRYPT.p,
  });
}

export async function verifyTeamsPassword(
  password: string,
  stored: TeamsPasswordCredential | undefined,
): Promise<boolean> {
  try {
    validatePassword(password);
  } catch {
    return false;
  }
  const parametersAreCurrent =
    stored?.n === TEAMS_PASSWORD_SCRYPT.N &&
    stored.r === TEAMS_PASSWORD_SCRYPT.r &&
    stored.p === TEAMS_PASSWORD_SCRYPT.p;
  const salt = parametersAreCurrent ? stored.salt : DUMMY_SALT;
  const expected = parametersAreCurrent ? stored.verifier : DUMMY_VERIFIER;
  const actual = await derive(password, salt);
  return parametersAreCurrent && timingSafeEqual(actual, Buffer.from(expected));
}
