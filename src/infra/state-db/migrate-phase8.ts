/**
 * One-shot migration: Phase 8.5 PROJECTS.md → SQLite.
 *
 * Reads PROJECTS.md, inserts into op1_projects + op1_telegram_topic_bindings.
 * Idempotent: skips if op1_projects already has data.
 * Deletes PROJECTS.md after successful migration.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import type { ProjectEntry } from "../../gateway/server-methods/projects.types.js";
import { insertProjectToDb, listProjectsFromDb } from "../../projects/project-store-sqlite.js";
import { bindTelegramTopic } from "../../projects/telegram-topic-binding-sqlite.js";

type MigrationResult = {
  store: string;
  count: number;
  migrated: boolean;
  error?: string;
};

// ── PROJECTS.md Parser (inlined from old MarkdownProjectStore) ──────

function parseProjectsMd(content: string): ProjectEntry[] {
  const entries: ProjectEntry[] = [];
  const lines = content.split("\n");

  let currentId: string | null = null;
  let current: Partial<ProjectEntry> & { telegram?: { group?: string; topicId?: number } } = {};
  let inTelegramBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    const h2Match = trimmed.match(/^## (.+)$/);
    if (h2Match) {
      if (currentId && current.path) {
        entries.push(finalizeEntry(currentId, current));
      }
      currentId = h2Match[1].trim();
      current = {};
      inTelegramBlock = false;
      continue;
    }

    if (trimmed.startsWith("# ")) {
      if (currentId && current.path) {
        entries.push(finalizeEntry(currentId, current));
      }
      currentId = null;
      current = {};
      inTelegramBlock = false;
      continue;
    }

    if (!currentId) {
      continue;
    }

    if (inTelegramBlock) {
      const subMatch = trimmed.match(/^- (.+?):\s*(.*)$/);
      if (subMatch) {
        const subKey = subMatch[1].toLowerCase();
        const subValue = subMatch[2].trim();
        if (!current.telegram) {
          current.telegram = {};
        }
        if (subKey === "group") {
          current.telegram.group = subValue;
        } else if (subKey === "topic") {
          const num = parseInt(subValue, 10);
          if (!isNaN(num)) {
            current.telegram.topicId = num;
          }
        }
        continue;
      }
      inTelegramBlock = false;
    }

    const fieldMatch = trimmed.match(/^- \*\*(.+?):\*\*\s*(.*)$/);
    if (fieldMatch) {
      const key = fieldMatch[1].toLowerCase();
      const value = fieldMatch[2].trim();
      switch (key) {
        case "name":
          current.name = value;
          break;
        case "path":
          current.path = value;
          break;
        case "type":
          current.type = value;
          break;
        case "tech":
          current.tech = value;
          break;
        case "status":
          current.status = value;
          break;
        case "default":
          current.isDefault = value.toLowerCase() === "true";
          break;
        case "keywords":
          current.keywords = value
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean);
          break;
        case "telegram":
          inTelegramBlock = true;
          break;
      }
    }
  }

  if (currentId && current.path) {
    entries.push(finalizeEntry(currentId, current));
  }

  return entries;
}

function finalizeEntry(
  id: string,
  partial: Partial<ProjectEntry> & { telegram?: { group?: string; topicId?: number } },
): ProjectEntry {
  const entry: ProjectEntry = {
    id,
    name: partial.name ?? id,
    path: partial.path ?? "",
    type: partial.type ?? "",
    tech: partial.tech ?? "",
    status: partial.status ?? "active",
    isDefault: partial.isDefault ?? false,
    keywords: partial.keywords ?? [],
  };
  if (partial.telegram) {
    entry.telegram = partial.telegram;
  }
  return entry;
}

// ── Migration ────────────────────────────────────────────────────────

function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

function resolveProjectsPath(): string | null {
  try {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    return path.join(workspaceDir, "PROJECTS.md");
  } catch {
    return null;
  }
}

export function migratePhase8ToSqlite(): MigrationResult[] {
  const result: MigrationResult = { store: "projects", count: 0, migrated: false };

  try {
    // Skip if SQLite already has projects.
    if (listProjectsFromDb().length > 0) {
      return [result];
    }

    const projectsPath = resolveProjectsPath();
    if (!projectsPath || !fs.existsSync(projectsPath)) {
      return [result];
    }

    const content = fs.readFileSync(projectsPath, "utf-8");
    const entries = parseProjectsMd(content);

    if (entries.length === 0) {
      return [result];
    }

    for (const entry of entries) {
      insertProjectToDb(entry);
      result.count++;

      // Migrate embedded telegram topic bindings to the dedicated table
      if (entry.telegram?.topicId != null) {
        bindTelegramTopic({
          chatId: "default",
          topicId: String(entry.telegram.topicId),
          projectId: entry.id,
          groupName: entry.telegram.group,
          boundBy: "migration",
        });
      }
    }

    result.migrated = true;
    tryUnlink(projectsPath);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return [result];
}
