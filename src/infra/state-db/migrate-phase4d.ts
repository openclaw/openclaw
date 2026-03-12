/**
 * One-shot migration: Phase 4D workspace/security JSON files → SQLite.
 *
 * Covers:
 *   - ~/.openclaw/exec-approvals.json → core_settings(scope='exec-approvals')
 *                                     + security_exec_approvals rows
 *   - {workspace}/.openclaw/workspace-state.json → workspace_state rows
 *   - {workspace}/.openclaw/clawhub/catalog.json → op1_clawhub_catalog rows
 *   - {workspace}/.openclaw/clawhub/previews/*.json → preview_json column
 *   - {workspace}/.openclaw/clawhub/clawhub.lock.json → op1_clawhub_locks rows
 *
 * Each migrator is idempotent: skips if DB already has data.
 * Files are removed after migration.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { ExecApprovalsFile } from "../exec-approvals.js";
import { loadJsonFile } from "../json-file.js";
import {
  replaceCatalogInDb,
  getAllLockEntriesFromDb,
  getClawhubSyncMeta,
  setClawhubSyncMeta,
  setSkillPreviewInDb,
  upsertLockEntryInDb,
} from "./clawhub-sqlite.js";
import { loadExecApprovalsFromDb, saveExecApprovalsToDb } from "./exec-approvals-sqlite.js";
import { getWorkspaceStateFromDb, setWorkspaceStateInDb } from "./workspace-state-sqlite.js";

type MigrationResult = {
  store: string;
  count: number;
  migrated: boolean;
  error?: string;
};

function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

/** Discover all workspace directories under stateDir. */
function findWorkspaceDirs(stateDir: string): string[] {
  const dirs: string[] = [];
  try {
    const entries = fs.readdirSync(stateDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === "workspace" || entry.name.startsWith("workspace-")) {
        dirs.push(path.join(stateDir, entry.name));
      }
    }
  } catch {
    // stateDir doesn't exist or can't be read — no workspaces
  }
  return dirs;
}

// ── Exec Approvals ─────────────────────────────────────────────────────────

function migrateExecApprovals(stateDir: string): MigrationResult {
  const result: MigrationResult = { store: "exec-approvals", count: 0, migrated: false };
  const filePath = path.join(stateDir, "exec-approvals.json");

  try {
    if (!fs.existsSync(filePath)) {
      return result;
    }

    // Skip if DB already has data
    if (loadExecApprovalsFromDb() != null) {
      tryUnlink(filePath);
      return result;
    }

    const raw = loadJsonFile(filePath) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || raw.version !== 1) {
      tryUnlink(filePath);
      return result;
    }

    saveExecApprovalsToDb(raw as unknown as ExecApprovalsFile);
    result.count = 1;
    result.migrated = true;
    tryUnlink(filePath);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

// ── Workspace State ─────────────────────────────────────────────────────────

function migrateWorkspaceState(workspaceDirs: string[]): MigrationResult {
  const result: MigrationResult = { store: "workspace-state", count: 0, migrated: false };

  for (const wsDir of workspaceDirs) {
    const filePath = path.join(wsDir, ".openclaw", "workspace-state.json");
    try {
      if (!fs.existsSync(filePath)) {
        continue;
      }

      // Skip if DB already has state for this workspace
      if (getWorkspaceStateFromDb(wsDir) != null) {
        tryUnlink(filePath);
        continue;
      }

      const raw = loadJsonFile(filePath) as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object") {
        tryUnlink(filePath);
        continue;
      }

      setWorkspaceStateInDb(wsDir, raw);
      result.count++;
      result.migrated = true;
      tryUnlink(filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.error = result.error ? `${result.error}; ${msg}` : msg;
    }
  }
  return result;
}

// ── Clawhub Catalog ─────────────────────────────────────────────────────────

function migrateClawHubCatalog(workspaceDirs: string[]): MigrationResult {
  const result: MigrationResult = { store: "clawhub-catalog", count: 0, migrated: false };

  for (const wsDir of workspaceDirs) {
    const catalogPath = path.join(wsDir, ".openclaw", "clawhub", "catalog.json");
    try {
      if (!fs.existsSync(catalogPath)) {
        continue;
      }

      // Skip if DB already has catalog for this workspace
      if (getClawhubSyncMeta(wsDir) != null) {
        tryUnlink(catalogPath);
        continue;
      }

      const raw = loadJsonFile(catalogPath) as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object") {
        tryUnlink(catalogPath);
        continue;
      }

      const skills = Array.isArray(raw.skills)
        ? (raw.skills as Array<Record<string, unknown>>)
        : [];
      const syncedAt = typeof raw.syncedAt === "string" ? raw.syncedAt : new Date().toISOString();

      replaceCatalogInDb(wsDir, skills);
      setClawhubSyncMeta(wsDir, { syncedAt, totalSkills: skills.length });
      result.count += skills.length;
      result.migrated = true;
      tryUnlink(catalogPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.error = result.error ? `${result.error}; ${msg}` : msg;
    }
  }
  return result;
}

// ── Clawhub Previews ─────────────────────────────────────────────────────────

function migrateClawHubPreviews(workspaceDirs: string[]): MigrationResult {
  const result: MigrationResult = { store: "clawhub-previews", count: 0, migrated: false };

  for (const wsDir of workspaceDirs) {
    const previewsDir = path.join(wsDir, ".openclaw", "clawhub", "previews");
    try {
      if (!fs.existsSync(previewsDir)) {
        continue;
      }

      const files = fs.readdirSync(previewsDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const filePath = path.join(previewsDir, file);
        try {
          const raw = loadJsonFile(filePath) as Record<string, unknown> | null;
          if (
            !raw ||
            typeof raw.slug !== "string" ||
            typeof raw.version !== "string" ||
            typeof raw.fetchedAt !== "string" ||
            typeof raw.content !== "string"
          ) {
            tryUnlink(filePath);
            continue;
          }

          setSkillPreviewInDb(wsDir, {
            slug: raw.slug,
            version: raw.version,
            fetchedAt: raw.fetchedAt,
            content: raw.content,
          });
          result.count++;
          result.migrated = true;
          tryUnlink(filePath);
        } catch {
          // skip individual corrupted preview
        }
      }

      // Remove empty previews dir
      try {
        if (fs.readdirSync(previewsDir).length === 0) {
          fs.rmdirSync(previewsDir);
        }
      } catch {
        // ignore
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.error = result.error ? `${result.error}; ${msg}` : msg;
    }
  }
  return result;
}

// ── Clawhub Lock ─────────────────────────────────────────────────────────────

function migrateClawHubLock(workspaceDirs: string[]): MigrationResult {
  const result: MigrationResult = { store: "clawhub-lock", count: 0, migrated: false };

  for (const wsDir of workspaceDirs) {
    const lockPath = path.join(wsDir, ".openclaw", "clawhub", "clawhub.lock.json");
    try {
      if (!fs.existsSync(lockPath)) {
        continue;
      }

      const raw = loadJsonFile(lockPath) as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object") {
        tryUnlink(lockPath);
        continue;
      }

      // Skip if DB already has lock entries for this workspace
      const existing = getAllLockEntriesFromDb(wsDir);
      if (Object.keys(existing).length > 0) {
        tryUnlink(lockPath);
        continue;
      }

      const now = Math.floor(Date.now() / 1000);
      for (const [slug, entry] of Object.entries(raw)) {
        if (!slug || typeof entry !== "object" || entry == null) {
          continue;
        }
        const version = (entry as { version?: string }).version ?? null;
        upsertLockEntryInDb(wsDir, slug, version, JSON.stringify(entry), now);
        result.count++;
      }

      if (result.count > 0) {
        result.migrated = true;
      }
      tryUnlink(lockPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.error = result.error ? `${result.error}; ${msg}` : msg;
    }
  }
  return result;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function migratePhase4dToSqlite(env: NodeJS.ProcessEnv = process.env): MigrationResult[] {
  const stateDir = resolveStateDir(env, () => os.homedir());
  const workspaceDirs = findWorkspaceDirs(stateDir);

  return [
    migrateExecApprovals(stateDir),
    migrateWorkspaceState(workspaceDirs),
    migrateClawHubCatalog(workspaceDirs),
    migrateClawHubPreviews(workspaceDirs),
    migrateClawHubLock(workspaceDirs),
  ];
}
