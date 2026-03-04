import { createHmac, timingSafeEqual } from "node:crypto";
import type { HookSignatureAlgorithm, HookSignatureFormat } from "../config/types.hooks.js";

export type HookSignatureProvider = {
  name: string;
  header: string;
  algorithm: HookSignatureAlgorithm;
  secret: string;
  format: HookSignatureFormat;
  timestampHeader?: string;
  timestampMaxAgeSeconds: number;
};

const DEFAULT_TIMESTAMP_MAX_AGE_SECONDS = 300;

export type HookSignatureResult = { ok: true; provider: string } | { ok: false; error: string };

/**
 * Extract the hex digest from a signature header value.
 * For 'prefixed' format (e.g. 'sha256=abc123'), strips the prefix.
 * For 'hex' format, returns the value as-is.
 */
function extractSignatureHex(raw: string, format: HookSignatureFormat): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (format === "prefixed") {
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 0) {
      return null;
    }
    const hex = trimmed.slice(eqIndex + 1).trim();
    return hex || null;
  }
  return trimmed;
}

/**
 * Verify an HMAC signature using constant-time comparison.
 */
export function verifyHmacSignature(params: {
  body: string;
  signatureHeader: string;
  algorithm: HookSignatureAlgorithm;
  secret: string;
  format: HookSignatureFormat;
}): boolean {
  const signatureHex = extractSignatureHex(params.signatureHeader, params.format);
  if (!signatureHex) {
    return false;
  }
  const expected = createHmac(params.algorithm, params.secret).update(params.body).digest("hex");
  // Constant-time comparison to prevent timing attacks.
  const expectedBuf = Buffer.from(expected, "utf-8");
  const providedBuf = Buffer.from(signatureHex.toLowerCase(), "utf-8");
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Check timestamp freshness for replay protection.
 * Returns true if the timestamp is within the allowed window.
 */
function isTimestampFresh(timestampValue: string, maxAgeSeconds: number): boolean {
  const parsed = Number(timestampValue);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const age = Math.abs(nowSeconds - parsed);
  return age <= maxAgeSeconds;
}

/**
 * Resolve signature providers from config into the internal format.
 */
export function resolveSignatureProviders(
  signatures: Record<
    string,
    {
      header: string;
      algorithm?: string;
      secret: string;
      format?: string;
      timestampHeader?: string;
      timestampMaxAgeSeconds?: number;
    }
  >,
): HookSignatureProvider[] {
  const providers: HookSignatureProvider[] = [];
  for (const [name, cfg] of Object.entries(signatures)) {
    providers.push({
      name,
      header: cfg.header.toLowerCase(),
      algorithm: (cfg.algorithm ?? "sha256") as HookSignatureAlgorithm,
      secret: cfg.secret,
      format: (cfg.format ?? "hex") as HookSignatureFormat,
      timestampHeader: cfg.timestampHeader?.toLowerCase(),
      timestampMaxAgeSeconds: cfg.timestampMaxAgeSeconds ?? DEFAULT_TIMESTAMP_MAX_AGE_SECONDS,
    });
  }
  return providers;
}

/**
 * Verify an incoming hook request against configured signature providers.
 * Iterates through providers to find one whose header is present, then verifies.
 */
export function verifyHookSignature(params: {
  rawBody: string;
  headers: Record<string, string>;
  providers: HookSignatureProvider[];
}): HookSignatureResult {
  const { rawBody, headers, providers } = params;
  if (providers.length === 0) {
    return { ok: false, error: "no signature providers configured" };
  }
  let lastMatchError: string | undefined;
  for (const provider of providers) {
    const signatureHeader = headers[provider.header];
    if (!signatureHeader) {
      continue;
    }
    // Check timestamp freshness if configured.
    if (provider.timestampHeader) {
      const timestampValue = headers[provider.timestampHeader];
      if (!timestampValue) {
        lastMatchError = `missing timestamp header: ${provider.timestampHeader}`;
        continue;
      }
      if (!isTimestampFresh(timestampValue, provider.timestampMaxAgeSeconds)) {
        lastMatchError = "timestamp expired or invalid";
        continue;
      }
    }
    const valid = verifyHmacSignature({
      body: rawBody,
      signatureHeader,
      algorithm: provider.algorithm,
      secret: provider.secret,
      format: provider.format,
    });
    if (valid) {
      return { ok: true, provider: provider.name };
    }
    lastMatchError = "signature verification failed";
  }
  return { ok: false, error: lastMatchError ?? "no matching signature header found" };
}
