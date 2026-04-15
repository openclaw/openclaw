import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GATEWAY_TOKEN_FILENAME = "gateway.token";
const SIG_EXTENSION = ".sig";

let cachedGatewayToken: string | null | undefined;

/**
 * Resolves the gateway token path at ~/.openclaw/gateway.token.
 */
function resolveGatewayTokenPath(): string {
  return path.join(os.homedir(), ".openclaw", GATEWAY_TOKEN_FILENAME);
}

/**
 * Reads and caches the gateway token from ~/.openclaw/gateway.token.
 * Returns null if the file does not exist or cannot be read.
 */
export function readGatewayToken(): string | null {
  if (cachedGatewayToken !== undefined) {
    return cachedGatewayToken;
  }
  try {
    const tokenPath = resolveGatewayTokenPath();
    const raw = fs.readFileSync(tokenPath, "utf-8").trim();
    cachedGatewayToken = raw.length > 0 ? raw : null;
  } catch {
    cachedGatewayToken = null;
  }
  return cachedGatewayToken;
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
  | { status: "no-sig" }
  | { status: "mismatch" }
  | { status: "error"; detail: string };

/**
 * Verifies the HMAC signature sidecar file against config content.
 * Returns a discriminated result indicating the verification outcome.
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
    return { status: "no-sig" };
  }
  if (storedHmac.length === 0) {
    return { status: "no-sig" };
  }
  try {
    const expectedHmac = computeConfigHmac(configContent, token);
    if (storedHmac === expectedHmac) {
      return { status: "ok" };
    }
    return { status: "mismatch" };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : "unknown error during HMAC verification";
    return { status: "error", detail };
  }
}

/**
 * Clears the cached gateway token. Useful for testing.
 */
export function clearGatewayTokenCache(): void {
  cachedGatewayToken = undefined;
}
