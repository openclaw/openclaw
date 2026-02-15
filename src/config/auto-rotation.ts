/**
 * Auto-rotation for secrets that support `rotation: "auto"`.
 *
 * First target: the OpenClaw gateway token (`openclaw-main-gateway-token`).
 *
 * Flow:
 *   1. Generate cryptographically random token (32 bytes, hex)
 *   2. Store as new version in GCP Secret Manager
 *   3. Verify the new version is readable
 *   4. Update local openclaw.json with the new token
 *   5. Set rotation metadata labels on the secret
 *   6. Gateway restart required after this (caller's responsibility)
 */

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Minimal GCP Secret Manager client interface (for testability)
export interface SmClient {
  addSecretVersion(req: {
    parent: string;
    payload: { data: Buffer };
  }): Promise<[{ name: string }]>;
  accessSecretVersion(req: {
    name: string;
  }): Promise<[{ payload?: { data?: Uint8Array | string } }]>;
  getSecret(req: { name: string }): Promise<[{ labels?: Record<string, string> }]>;
  updateSecret(req: {
    secret: { name: string; labels: Record<string, string> };
    updateMask: { paths: string[] };
  }): Promise<[unknown]>;
}

export interface RotationDeps {
  project: string;
  secretName: string;
  configPath: string;
  intervalDays?: number;
  readConfig: (path: string) => Promise<any>;
  writeConfig: (path: string, config: any) => Promise<void>;
  getClient: () => Promise<SmClient>;
}

export interface RotationResult {
  success: boolean;
  oldToken: string;
  newToken: string;
  versionName?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Token Generation
// ---------------------------------------------------------------------------

export function generateSecureToken(bytes = 32): string {
  if (bytes < 16) {
    throw new Error("Token must be at least 16 bytes for security");
  }
  return randomBytes(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// GCP Secret Manager Operations
// ---------------------------------------------------------------------------

export async function storeNewSecretVersion(
  client: SmClient,
  project: string,
  secretName: string,
  value: string,
): Promise<string> {
  const [result] = await client.addSecretVersion({
    parent: `projects/${project}/secrets/${secretName}`,
    payload: { data: Buffer.from(value, "utf-8") },
  });
  return result.name;
}

function encodeTimestamp(d: Date): string {
  return d.toISOString().toLowerCase().replace(/[:.]/g, "-");
}

export async function updateRotationLabels(
  client: SmClient,
  project: string,
  secretName: string,
  intervalDays: number,
  now: Date = new Date(),
): Promise<void> {
  const resourceName = `projects/${project}/secrets/${secretName}`;
  const [secret] = await client.getSecret({ name: resourceName });
  const existingLabels = secret.labels ?? {};

  const newLabels: Record<string, string> = {
    ...existingLabels,
    "rotation-type": "auto",
    "rotation-interval-days": String(intervalDays),
    "last-rotated": encodeTimestamp(now),
  };

  await client.updateSecret({
    secret: { name: resourceName, labels: newLabels },
    updateMask: { paths: ["labels"] },
  });
}

// ---------------------------------------------------------------------------
// Local Config Update
// ---------------------------------------------------------------------------

export function updateLocalConfig(config: any, newToken: string): any {
  if (!config?.gateway?.auth?.token) {
    throw new Error("Config does not contain gateway.auth.token");
  }
  return {
    ...config,
    gateway: {
      ...config.gateway,
      auth: {
        ...config.gateway.auth,
        token: newToken,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Default file helpers
// ---------------------------------------------------------------------------

async function defaultReadConfig(path: string): Promise<any> {
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw);
}

async function defaultWriteConfig(path: string, config: any): Promise<void> {
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

async function defaultGetClient(): Promise<SmClient> {
  const mod = await import("@google-cloud/secret-manager");
  return new mod.SecretManagerServiceClient() as unknown as SmClient;
}

// ---------------------------------------------------------------------------
// Main Rotation Function
// ---------------------------------------------------------------------------

export async function rotateGatewayToken(deps: RotationDeps): Promise<RotationResult> {
  const {
    project,
    secretName,
    configPath,
    intervalDays = 30,
    readConfig,
    writeConfig,
    getClient,
  } = deps;

  // 1. Read current config to get old token
  const config = await readConfig(configPath);
  const oldToken = config?.gateway?.auth?.token;
  if (!oldToken) {
    return { success: false, oldToken: "", newToken: "", error: "No gateway token found in config" };
  }

  // 2. Generate new token
  const newToken = generateSecureToken(32);

  // 3. Store in GCP
  const client = await getClient();
  let versionName: string;
  try {
    versionName = await storeNewSecretVersion(client, project, secretName, newToken);
  } catch (err: unknown) {
    return {
      success: false,
      oldToken,
      newToken,
      error: `Failed to store new version in GCP: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 4. Verify the new version is readable
  try {
    await client.accessSecretVersion({
      name: `projects/${project}/secrets/${secretName}/versions/latest`,
    });
  } catch (err: unknown) {
    return {
      success: false,
      oldToken,
      newToken,
      error: `GCP verification failed — new token stored but not readable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 5. Update local config
  try {
    const updatedConfig = updateLocalConfig(config, newToken);
    await writeConfig(configPath, updatedConfig);
  } catch (err: unknown) {
    return {
      success: false,
      oldToken,
      newToken,
      versionName,
      error: `Failed to update local config (old token: ${oldToken}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 6. Update rotation labels
  try {
    await updateRotationLabels(client, project, secretName, intervalDays);
  } catch {
    // Non-fatal — token is already rotated, labels are just metadata
  }

  return { success: true, oldToken, newToken, versionName };
}

// ---------------------------------------------------------------------------
// Convenience: create deps from defaults
// ---------------------------------------------------------------------------

export function createDefaultDeps(overrides?: Partial<RotationDeps>): RotationDeps {
  return {
    project: "n30-agents",
    secretName: "openclaw-main-gateway-token",
    configPath: `${process.env.HOME}/.openclaw/openclaw.json`,
    intervalDays: 30,
    readConfig: defaultReadConfig,
    writeConfig: defaultWriteConfig,
    getClient: defaultGetClient,
    ...overrides,
  };
}
