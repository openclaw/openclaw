/**
 * TOTP (Time-based One-Time Password) utilities
 *
 * Implements RFC 6238 TOTP for two-factor authentication using only Node.js crypto.
 */

import crypto from "node:crypto";
import type { TwoFactorSetupData, RecoveryCodesData } from "./types.js";
import { RECOVERY_CODE_COUNT, RECOVERY_CODE_LENGTH } from "./types.js";

/** TOTP issuer name shown in authenticator apps */
const TOTP_ISSUER = "Clawdbrain";

/** TOTP digits (standard is 6) */
const TOTP_DIGITS = 6;

/** TOTP period in seconds (standard is 30) */
const TOTP_PERIOD = 30;

/** TOTP algorithm */
const TOTP_ALGORITHM = "sha1";

/** Base32 character set (RFC 4648) */
const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Encode bytes to base32.
 */
function base32Encode(buffer: Buffer): string {
  let result = "";
  let bits = 0;
  let value = 0;

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      result += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    result += BASE32_CHARS[(value << (5 - bits)) & 31];
  }

  return result;
}

/**
 * Decode base32 to bytes.
 */
function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const char of cleaned) {
    const index = BASE32_CHARS.indexOf(char);
    if (index === -1) continue;

    value = (value << 5) | index;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * Generate HMAC-based OTP (HOTP) - RFC 4226.
 */
function generateHOTP(secret: Buffer, counter: bigint, digits: number = 6): string {
  // Convert counter to 8-byte big-endian buffer
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);

  // Generate HMAC-SHA1
  const hmac = crypto.createHmac(TOTP_ALGORITHM, secret);
  hmac.update(counterBuffer);
  const hash = hmac.digest();

  // Dynamic truncation
  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  // Generate OTP
  const otp = binary % Math.pow(10, digits);
  return otp.toString().padStart(digits, "0");
}

/**
 * Generate TOTP for current time - RFC 6238.
 */
function generateTOTP(
  secret: Buffer,
  timestamp: number = Date.now(),
  period: number = TOTP_PERIOD,
  digits: number = TOTP_DIGITS,
): string {
  const counter = BigInt(Math.floor(timestamp / 1000 / period));
  return generateHOTP(secret, counter, digits);
}

/**
 * Generate a new TOTP secret.
 */
export function generateTotpSecret(): string {
  // Generate 20 random bytes (160 bits) for the secret
  const secretBytes = crypto.randomBytes(20);
  return base32Encode(secretBytes);
}

/**
 * Build an otpauth URL for authenticator apps.
 */
function buildOtpauthUrl(secret: string, accountName: string): string {
  const issuer = encodeURIComponent(TOTP_ISSUER);
  const account = encodeURIComponent(accountName);
  const encodedSecret = encodeURIComponent(secret);

  return `otpauth://totp/${issuer}:${account}?secret=${encodedSecret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

/**
 * Generate a simple ASCII QR code as a data URL (SVG-based).
 * For production, users should be able to manually enter the secret.
 */
async function generateQRCodeDataUrl(text: string): Promise<string> {
  // Generate a simple SVG-based placeholder that includes the text
  // In production, you'd want to use a proper QR library or generate server-side
  // For now, we'll create a simple "manual entry" fallback

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
    <rect width="200" height="200" fill="white"/>
    <text x="100" y="90" text-anchor="middle" font-family="Arial" font-size="12" fill="black">
      Scan with authenticator
    </text>
    <text x="100" y="110" text-anchor="middle" font-family="Arial" font-size="12" fill="black">
      or enter code manually
    </text>
    <rect x="40" y="130" width="120" height="30" fill="#f0f0f0" stroke="#ccc" rx="4"/>
    <text x="100" y="150" text-anchor="middle" font-family="monospace" font-size="10" fill="black">
      See secret below
    </text>
  </svg>`;

  const base64 = Buffer.from(svg).toString("base64");
  return `data:image/svg+xml;base64,${base64}`;
}

/**
 * Generate TOTP setup data including QR code.
 */
export async function generateTotpSetupData(
  accountName: string = "user",
): Promise<TwoFactorSetupData> {
  const secret = generateTotpSecret();
  const otpauthUrl = buildOtpauthUrl(secret, accountName);

  // Note: For a production app, you'd want to use a proper QR code library
  // or generate QR codes server-side. This creates a placeholder.
  const qrCodeDataUrl = await generateQRCodeDataUrl(otpauthUrl);

  return {
    secret,
    otpauthUrl,
    qrCodeDataUrl,
  };
}

/**
 * Verify a TOTP code against a secret.
 */
export function verifyTotpCode(secret: string, code: string): boolean {
  const secretBuffer = base32Decode(secret);
  const now = Date.now();

  // Allow 1 period of drift in either direction
  for (let i = -1; i <= 1; i++) {
    const timestamp = now + i * TOTP_PERIOD * 1000;
    const expectedCode = generateTOTP(secretBuffer, timestamp);

    // Constant-time comparison
    if (code.length === expectedCode.length) {
      let result = 0;
      for (let j = 0; j < code.length; j++) {
        result |= code.charCodeAt(j) ^ expectedCode.charCodeAt(j);
      }
      if (result === 0) return true;
    }
  }

  return false;
}

/**
 * Generate recovery codes.
 */
export function generateRecoveryCodes(): RecoveryCodesData {
  const codes: string[] = [];

  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    // Generate alphanumeric characters
    const bytes = crypto.randomBytes(RECOVERY_CODE_LENGTH);
    let code = "";

    for (const byte of bytes) {
      // Use alphanumeric characters only (A-Z, 0-9)
      const charIndex = byte % 36;
      if (charIndex < 10) {
        code += String.fromCharCode(48 + charIndex); // 0-9
      } else {
        code += String.fromCharCode(55 + charIndex); // A-Z (65 - 10 = 55)
      }
    }

    codes.push(code.slice(0, RECOVERY_CODE_LENGTH));
  }

  return {
    codes,
    generatedAt: Date.now(),
  };
}

/**
 * Hash a recovery code for storage.
 */
export function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(code.toUpperCase()).digest("hex");
}

/**
 * Verify a recovery code against stored hashes.
 * Returns the index of the matched code, or -1 if not found.
 */
export function verifyRecoveryCode(code: string, hashedCodes: string[]): number {
  const hash = hashRecoveryCode(code);
  return hashedCodes.indexOf(hash);
}
