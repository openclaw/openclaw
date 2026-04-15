import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GATEWAY_TOKEN_FILENAME = "gateway.token";
const SIG_EXTENSION = ".sig";

/**
 * Resolves the gateway token path at ~/.openclaw/gateway.token.
 */
function resolveGatewayTokenPath(): string {
  return path.join(os.homedir(), ".openclaw", GATEWAY_TOKEN_FILENAME);
}

/**
 * Reads the gateway token from ~/.openclaw/gateway.token.
 * No process-lifetime cache — reads fresh from disk each call so token
 * rotation takes effect immediately without a gateway restart.
 */
export function readGatewayToken(): string | null {
  try {
    const tokenPath = resolveGatewayTokenPath();
    const raw = fs.readFileSync(tokenPath, "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
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
 * Writes the HMAC signature sidecar file after a config write.
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
    const suspicious = (() => {
      try {
        return fs.statSync(configPath).size > 100;
      } catch {
        return false;
      }
    })();
    return { status: "no-sig", suspicious };
  }
  if (storedHmac.length === 0) {
    return { status: "no-sig", suspicious: false };
  }
  try {
    const expectedHmac = computeConfigHmac(configContent, token);
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
