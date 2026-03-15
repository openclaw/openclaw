/**
 * Grant file manager for time-limited secret access.
 *
 * Grants are stored as files in {dataDir}/grants/:
 * - Filename: {name}.grant
 * - Content: Unix timestamp (expiry)
 * - Permissions: 0644 (readable by openclaw user, writable by human)
 *
 * SECURITY NOTE: Self-grant prevention is an application-level concern handled
 * through process isolation at deployment time. The grant directory should be
 * owned by the human user (not the AI process user) to prevent AI self-approval.
 * This cannot be enforced in code alone — requires OS-level permission boundaries.
 * See deployment documentation for proper directory ownership configuration.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { STATE_DIR } from "../config/paths.js";

export interface GrantInfo {
  valid: boolean;
  expiresAt?: number;
  remainingMinutes?: number;
}

/**
 * Get the grants directory path.
 * Default: ~/.openclaw/grants/
 */
export function getGrantsDir(): string {
  return path.join(STATE_DIR, "grants");
}

/**
 * Ensure the grants directory exists.
 */
async function ensureGrantsDir(): Promise<void> {
  const dir = getGrantsDir();
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o755 });
  } catch {
    // Ignore if already exists
  }
}

/**
 * Validate secret name to prevent path traversal and enforce constraints.
 * @param name Secret name to validate
 * @throws Error if name is invalid
 */
export function validateSecretName(name: string): void {
  // Length check: 1-128 characters
  if (!name || name.length === 0 || name.length > 128) {
    throw new Error("Secret name must be 1-128 characters");
  }

  // Path traversal protection: reject .., /, \, null bytes
  if (name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error(`Invalid secret name: contains path traversal characters`);
  }

  // Character whitelist: alphanumeric + underscore, dash, colon, dot, @
  if (!/^[a-zA-Z0-9_\-:.@]+$/.test(name)) {
    throw new Error(
      "Secret name must contain only alphanumeric characters, underscore, dash, colon, dot, or @",
    );
  }
}

/**
 * Get the full path for a grant file.
 */
function getGrantPath(name: string): string {
  validateSecretName(name);
  return path.join(getGrantsDir(), `${name}.grant`);
}

/**
 * Check if a grant exists and is valid.
 * @param name Secret name
 * @returns Grant status information
 */
export async function checkGrant(name: string): Promise<GrantInfo> {
  const grantPath = getGrantPath(name);

  try {
    const content = await fs.readFile(grantPath, "utf8");
    const expiresAt = Number.parseInt(content.trim(), 10);

    if (!Number.isFinite(expiresAt)) {
      // Invalid grant file
      await revokeGrant(name);
      return { valid: false };
    }

    const now = Math.floor(Date.now() / 1000);

    if (expiresAt <= now) {
      // Expired grant
      await revokeGrant(name);
      return {
        valid: false,
        expiresAt,
        remainingMinutes: 0,
      };
    }

    const remainingSeconds = expiresAt - now;
    const remainingMinutes = Math.ceil(remainingSeconds / 60);

    return {
      valid: true,
      expiresAt,
      remainingMinutes,
    };
  } catch {
    // Grant file doesn't exist or can't be read
    return { valid: false };
  }
}

/**
 * Write a new grant file with TTL.
 * @param name Secret name
 * @param ttlMinutes Time-to-live in minutes
 */
export async function writeGrant(name: string, ttlMinutes: number): Promise<void> {
  await ensureGrantsDir();

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + ttlMinutes * 60;

  const grantPath = getGrantPath(name);
  await fs.writeFile(grantPath, String(expiresAt), {
    encoding: "utf8",
    mode: 0o644,
  });
}

/**
 * Revoke a grant by deleting its file.
 * @param name Secret name
 */
export async function revokeGrant(name: string): Promise<void> {
  const grantPath = getGrantPath(name);

  try {
    await fs.unlink(grantPath);
  } catch {
    // Ignore if file doesn't exist
  }
}

/**
 * List all grants with their status.
 * Automatically cleans up expired grants.
 * @returns Array of grant names and their validity
 */
export async function listGrants(): Promise<Array<{ name: string; info: GrantInfo }>> {
  await ensureGrantsDir();
  const grantsDir = getGrantsDir();

  try {
    const files = await fs.readdir(grantsDir);
    const grantFiles = files.filter((f) => f.endsWith(".grant"));

    const results = await Promise.all(
      grantFiles.map(async (file) => {
        const name = file.replace(/\.grant$/, "");
        const info = await checkGrant(name);
        return { name, info };
      }),
    );

    // Automatic cleanup: revoke expired grants (checkGrant already does this)
    // This ensures the list reflects current state after cleanup
    const validResults = results.filter((r) => r.info.valid);

    return validResults;
  } catch {
    return [];
  }
}

/**
 * Clean up all expired grants.
 * @returns Number of grants revoked
 */
export async function cleanupExpiredGrants(): Promise<number> {
  const grants = await listGrants();
  const expired = grants.filter((g) => !g.info.valid);

  await Promise.all(expired.map((g) => revokeGrant(g.name)));

  return expired.length;
}
