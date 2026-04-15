import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GATEWAY_TOKEN_FILENAME = "gateway.token";
const SIG_EXTENSION = ".sig";

/**
 * Resolves the gateway token for HMAC operations.
 *
 * Checks three sources in order (matching gateway auth token resolution):
 * 1. `~/.openclaw/gateway.token` file (most common)
 * 2. `OPENCLAW_GATEWAY_TOKEN` environment variable
 *
 * No process-lifetime cache — reads fresh each call so token rotation
 * takes effect immediately without a gateway restart.
 *
 * Note: `gateway.auth.token` from config is NOT checked here because
 * reading it would create a circular dependency (config read needs HMAC
 * verification, but HMAC needs the config to resolve SecretRefs).
 */
export function readGatewayToken(): string | null {
  // Source 1: token file on disk
  try {
    const tokenPath = path.join(os.homedir(), ".openclaw", GATEWAY_TOKEN_FILENAME);
    const raw = fs.readFileSync(tokenPath, "utf-8").trim();
    if (raw.length > 0) {
      return raw;
    }
  } catch {
    // fall through to env
  }
  // Source 2: environment variable
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envToken && envToken.length > 0) {
    return envToken;
  }
  return null;
}

/**
 * Computes HMAC-SHA256 of config content using the gateway token.
 */
export function computeConfigHmac(content: string, token: string): string {
  return crypto.createHmac("sha256", token).update(content).digest("hex");
}

/**
 * Resolves the sidecar HMAC signature file path for a config path.
 */
export function resolveConfigSigPath(configPath: string): string {
  return `${configPath}${SIG_EXTENSION}`;
}

/**
 * Writes the HMAC signature sidecar file after a config write (async).
 * Best-effort; failures are silently ignored.
 */
export async function writeConfigHmacSig(configPath: string, configContent: string): Promise<void> {
  const token = readGatewayToken();
  if (!token) {
    return;
  }
  try {
    const hmac = computeConfigHmac(configContent, token);
    const sigPath = resolveConfigSigPath(configPath);
    await fs.promises.writeFile(sigPath, hmac, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // best-effort
  }
}

/**
 * Writes the HMAC signature sidecar file after a config write (sync).
 * Used by internal createConfigIO write paths that don't use the
 * exported async writeConfigFile wrapper.
 */
export function writeConfigHmacSigSync(configPath: string, configContent: string): void {
  const token = readGatewayToken();
  if (!token) {
    return;
  }
  try {
    const hmac = computeConfigHmac(configContent, token);
    const sigPath = resolveConfigSigPath(configPath);
    fs.writeFileSync(sigPath, hmac, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // best-effort
  }
}

export type ConfigHmacVerifyResult =
  | { status: "ok" }
  | { status: "no-token" }
  | { status: "no-sig"; suspicious: boolean }
  | { status: "mismatch" }
  | { status: "error"; detail: string };

/**
 * Verifies the HMAC signature sidecar file against config content.
 *
 * When `no-sig` is returned with `suspicious: true`, it means a sig file
 * was expected (config exists and is established) but is missing —
 * this could indicate the sig was deleted to bypass integrity checks.
 */
export function verifyConfigHmac(
  configPath: string,
  configContent: string,
): ConfigHmacVerifyResult {
  const token = readGatewayToken();
  if (!token) {
    return { status: "no-token" };
  }
  const sigPath = resolveConfigSigPath(configPath);
  let storedHmac: string;
  try {
    storedHmac = fs.readFileSync(sigPath, "utf-8").trim();
  } catch {
    // Sig file missing. If config is established (>100 bytes), treat as suspicious.
    const suspicious = (() => {
      try {
        return fs.statSync(configPath).size > 100;
      } catch {
        return false;
      }
    })();
    return { status: "no-sig", suspicious };
  }
  // Empty sig file = suspicious. An attacker could truncate the sig to bypass.
  if (storedHmac.length === 0) {
    const suspicious = (() => {
      try {
        return fs.statSync(configPath).size > 100;
      } catch {
        return false;
      }
    })();
    return { status: "no-sig", suspicious };
  }
  try {
    const expectedHmac = computeConfigHmac(configContent, token);
    // Constant-time comparison to prevent timing side-channel attacks.
    const stored = Buffer.from(storedHmac, "hex");
    const expected = Buffer.from(expectedHmac, "hex");
    if (stored.length === expected.length && crypto.timingSafeEqual(stored, expected)) {
      return { status: "ok" };
    }
    return { status: "mismatch" };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : "unknown error during HMAC verification";
    return { status: "error", detail };
  }
}
