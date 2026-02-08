import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const DEFAULT_DIGITS = 6;
const DEFAULT_TIME_STEP = 30;
const DEFAULT_WINDOW = 1;

/** Generate a random TOTP secret. */
export function generateTotpSecret(bytes = 20): Buffer {
  return crypto.randomBytes(bytes);
}

/** RFC 4648 base32 encode. */
export function encodeBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/** RFC 4648 base32 decode. */
export function decodeBase32(str: string): Buffer {
  const cleaned = str.replace(/[=\s]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) {
      throw new Error(`invalid base32 character: ${char}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** Generate a TOTP code for the given counter value (RFC 6238 / RFC 4226). */
function hotpCode(secret: Buffer, counter: bigint, digits: number): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac("sha1", secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(code % 10 ** digits).padStart(digits, "0");
}

/** Generate a TOTP code for the current time. */
export function generateTotp(
  secret: Buffer,
  timeStep = DEFAULT_TIME_STEP,
  digits = DEFAULT_DIGITS,
): string {
  const counter = BigInt(Math.floor(Date.now() / 1000 / timeStep));
  return hotpCode(secret, counter, digits);
}

/** Verify a TOTP code with a configurable time window for clock skew. */
export function verifyTotp(
  secret: Buffer,
  code: string,
  window = DEFAULT_WINDOW,
  timeStep = DEFAULT_TIME_STEP,
  digits = DEFAULT_DIGITS,
): boolean {
  const now = BigInt(Math.floor(Date.now() / 1000 / timeStep));
  for (let i = -window; i <= window; i++) {
    const counter = now + BigInt(i);
    if (hotpCode(secret, counter, digits) === code) {
      return true;
    }
  }
  return false;
}

/** Build an otpauth:// URI for authenticator app setup. */
export function buildOtpauthUri(params: {
  secret: string;
  issuer: string;
  account: string;
}): string {
  const label = `${encodeURIComponent(params.issuer)}:${encodeURIComponent(params.account)}`;
  const qs = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(DEFAULT_DIGITS),
    period: String(DEFAULT_TIME_STEP),
  });
  return `otpauth://totp/${label}?${qs.toString()}`;
}
