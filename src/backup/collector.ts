/**
 * Collect files from the OpenClaw state directory for backup.
 *
 * @module backup/collector
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { BackupComponent } from "./types.js";
import { resolveConfigPathCandidate, resolveStateDir } from "../config/paths.js";
import { DEFAULT_CRON_STORE_PATH } from "../cron/store.js";
import { CORE_BACKUP_COMPONENTS } from "./types.js";

/** Secrets / sensitive keys to strip from the config before backup. */
const SENSITIVE_CONFIG_KEYS = new Set([
  "apiKey",
  "apiSecret",
  "token",
  "secret",
  "password",
  "accessKeyId",
  "secretAccessKey",
]);

/**
 * Recursively strip known sensitive fields from a config object.
 */
function stripSecrets(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(stripSecrets);
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_CONFIG_KEYS.has(key) && typeof value === "string") {
        result[key] = "***REDACTED***";
      } else {
        result[key] = stripSecrets(value);
      }
    }
    return result;
  }
  return obj;
}

/**
 * A file to be included in the backup archive.
 */
export type CollectedFile = {
  /** Relative path inside the archive (e.g., "config/openclaw.json"). */
  archivePath: string;
  /** Absolute path on disk. */
  sourcePath: string;
  /** If set, use this content instead of reading sourcePath (for redacted configs). */
  content?: string;
};

/**
 * Collect files based on selected components.
 */
export async function collectFiles(opts: {
  components?: BackupComponent[];
  stateDir?: string;
  agentDir?: string;
}): Promise<CollectedFile[]> {
  const components = opts.components ?? [...CORE_BACKUP_COMPONENTS];
  const stateDir = opts.stateDir ?? resolveStateDir();
  const files: CollectedFile[] = [];

  for (const component of components) {
    switch (component) {
      case "config":
        await collectConfig(files, stateDir);
        break;
      case "workspace":
        await collectWorkspace(files, stateDir, opts.agentDir);
        break;
      case "cron":
        await collectCron(files);
        break;
      case "skills":
        await collectSkills(files, stateDir);
        break;
      case "sessions":
        await collectSessions(files, stateDir, opts.agentDir);
        break;
      case "approvals":
        await collectApprovals(files, stateDir);
        break;
      case "pairing":
        await collectPairing(files, stateDir);
        break;
    }
  }

  return files;
}

async function collectConfig(files: CollectedFile[], stateDir: string): Promise<void> {
  const configPath = resolveConfigPathCandidate() ?? path.join(stateDir, "openclaw.json");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const redacted = stripSecrets(parsed);
    files.push({
      archivePath: "config/openclaw.json",
      sourcePath: configPath,
      content: JSON.stringify(redacted, null, 2),
    });
  } catch {
    // config not found — skip
  }
}

async function collectWorkspace(
  files: CollectedFile[],
  stateDir: string,
  agentDir?: string,
): Promise<void> {
  // The agent workspace contains SOUL.md, MEMORY.md, and memory/ directory
  const workspaceDir = agentDir ?? path.join(stateDir, "agents", "default", "agent");
  await collectDirRecursive(files, workspaceDir, "workspace", [
    "SOUL.md",
    "MEMORY.md",
    "memory",
    "skills",
    "USER.md",
  ]);
}

async function collectCron(files: CollectedFile[]): Promise<void> {
  try {
    await fs.access(DEFAULT_CRON_STORE_PATH);
    files.push({
      archivePath: "cron/jobs.json",
      sourcePath: DEFAULT_CRON_STORE_PATH,
    });
  } catch {
    // no cron store
  }
}

async function collectSkills(files: CollectedFile[], stateDir: string): Promise<void> {
  const skillsDir = path.join(stateDir, "skills");
  await collectDirRecursive(files, skillsDir, "skills");
}

async function collectSessions(
  files: CollectedFile[],
  stateDir: string,
  agentDir?: string,
): Promise<void> {
  const workspaceDir = agentDir ?? path.join(stateDir, "agents", "default", "agent");
  const sessionsPath = path.join(workspaceDir, "sessions.json");
  try {
    await fs.access(sessionsPath);
    files.push({
      archivePath: "sessions/sessions.json",
      sourcePath: sessionsPath,
    });
  } catch {
    // no sessions
  }
}

async function collectApprovals(files: CollectedFile[], stateDir: string): Promise<void> {
  const approvalsPath = path.join(stateDir, "exec-approvals.json");
  try {
    await fs.access(approvalsPath);
    files.push({
      archivePath: "approvals/exec-approvals.json",
      sourcePath: approvalsPath,
    });
  } catch {
    // no approvals
  }
}

async function collectPairing(files: CollectedFile[], stateDir: string): Promise<void> {
  const pairingDir = path.join(stateDir, "pairing");
  await collectDirRecursive(files, pairingDir, "pairing");
}

/**
 * Recursively collect files from a directory.
 * If `allowList` is provided, only include files/dirs whose name matches.
 */
async function collectDirRecursive(
  files: CollectedFile[],
  baseDir: string,
  archivePrefix: string,
  allowList?: string[],
): Promise<void> {
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (allowList && !allowList.includes(entry.name)) {
        continue;
      }
      const fullPath = path.join(baseDir, entry.name);
      const archivePath = `${archivePrefix}/${entry.name}`;
      if (entry.isFile()) {
        files.push({ archivePath, sourcePath: fullPath });
      } else if (entry.isDirectory()) {
        await collectDirRecursive(files, fullPath, archivePath);
      }
    }
  } catch {
    // directory doesn't exist – skip
  }
}
