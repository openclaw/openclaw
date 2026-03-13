/**
 * SQLite-backed ProjectStore (replaces MarkdownProjectStore / PROJECTS.md).
 */
import fs from "node:fs";
import path from "node:path";
import type {
  ProjectEntry,
  ProjectDetails,
  ProjectStore,
} from "../gateway/server-methods/projects.types.js";
import { getStateDb } from "../infra/state-db/connection.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(process.env.HOME ?? "/", p.slice(2));
  }
  return p;
}

function readOptionalFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

type ProjectRow = {
  id: string;
  name: string;
  path: string;
  type: string | null;
  tech: string | null;
  status: string | null;
  is_default: number;
  keywords_json: string | null;
  telegram_group: string | null;
  telegram_topic_id: number | null;
};

function rowToEntry(r: ProjectRow): ProjectEntry {
  const entry: ProjectEntry = {
    id: r.id,
    name: r.name,
    path: r.path,
    type: r.type ?? "",
    tech: r.tech ?? "",
    status: r.status ?? "active",
    isDefault: r.is_default !== 0,
    keywords: parseKeywords(r.keywords_json),
  };
  if (r.telegram_group || r.telegram_topic_id != null) {
    entry.telegram = {};
    if (r.telegram_group) {
      entry.telegram.group = r.telegram_group;
    }
    if (r.telegram_topic_id != null) {
      entry.telegram.topicId = r.telegram_topic_id;
    }
  }
  return entry;
}

function parseKeywords(json: string | null): string[] {
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── Store Error ──────────────────────────────────────────────────────────────

export class ProjectStoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ProjectStoreError";
  }
}

// ── CRUD Functions (used by store + migration) ───────────────────────────────

const SELECT_COLS =
  "id, name, path, type, tech, status, is_default, keywords_json, telegram_group, telegram_topic_id";

export function listProjectsFromDb(): ProjectEntry[] {
  const db = getStateDb();
  const rows = db
    .prepare(`SELECT ${SELECT_COLS} FROM op1_projects ORDER BY name`)
    .all() as ProjectRow[];
  return rows.map(rowToEntry);
}

export function getProjectFromDb(id: string): ProjectRow | undefined {
  const db = getStateDb();
  return db.prepare(`SELECT ${SELECT_COLS} FROM op1_projects WHERE id = ?`).get(id) as
    | ProjectRow
    | undefined;
}

export function insertProjectToDb(entry: ProjectEntry): void {
  const db = getStateDb();
  db.prepare(
    `INSERT INTO op1_projects (id, name, path, type, tech, status, is_default, keywords_json, telegram_group, telegram_topic_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`,
  ).run(
    entry.id,
    entry.name,
    entry.path,
    entry.type || null,
    entry.tech || null,
    entry.status || "active",
    entry.isDefault ? 1 : 0,
    JSON.stringify(entry.keywords ?? []),
    entry.telegram?.group ?? null,
    entry.telegram?.topicId ?? null,
  );
}

export function updateProjectInDb(id: string, patch: Partial<ProjectEntry>): void {
  const db = getStateDb();
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (patch.name !== undefined) {
    sets.push("name = ?");
    params.push(patch.name);
  }
  if (patch.path !== undefined) {
    sets.push("path = ?");
    params.push(patch.path);
  }
  if (patch.type !== undefined) {
    sets.push("type = ?");
    params.push(patch.type || null);
  }
  if (patch.tech !== undefined) {
    sets.push("tech = ?");
    params.push(patch.tech || null);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  if (patch.isDefault !== undefined) {
    sets.push("is_default = ?");
    params.push(patch.isDefault ? 1 : 0);
  }
  if (patch.keywords !== undefined) {
    sets.push("keywords_json = ?");
    params.push(JSON.stringify(patch.keywords));
  }
  if (patch.telegram !== undefined) {
    sets.push("telegram_group = ?");
    params.push(patch.telegram?.group ?? null);
    sets.push("telegram_topic_id = ?");
    params.push(patch.telegram?.topicId ?? null);
  }

  if (sets.length === 0) {
    return;
  }

  sets.push("updated_at = unixepoch()");
  params.push(id);
  db.prepare(`UPDATE op1_projects SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

export function deleteProjectFromDb(id: string): boolean {
  const db = getStateDb();
  const result = db.prepare("DELETE FROM op1_projects WHERE id = ?").run(id);
  return (result.changes as number) > 0;
}

// ── ProjectStore Implementation ──────────────────────────────────────────────

export function createSqliteProjectStore(): ProjectStore {
  return {
    async list() {
      return listProjectsFromDb();
    },

    async get(id: string) {
      const row = getProjectFromDb(id);
      if (!row) {
        throw new ProjectStoreError("PROJECT_NOT_FOUND", `No project with id '${id}'`);
      }

      const entry = rowToEntry(row);
      const projectPath = expandHome(entry.path);
      const openclawDir = path.join(projectPath, ".openclaw");

      const details: ProjectDetails = {
        ...entry,
        soul: fs.existsSync(openclawDir)
          ? readOptionalFile(path.join(openclawDir, "SOUL.md"))
          : null,
        agents: fs.existsSync(openclawDir)
          ? readOptionalFile(path.join(openclawDir, "AGENTS.md"))
          : null,
        tools: fs.existsSync(openclawDir)
          ? readOptionalFile(path.join(openclawDir, "TOOLS.md"))
          : null,
      };

      return details;
    },

    async add(entry: ProjectEntry) {
      const existing = getProjectFromDb(entry.id);
      if (existing) {
        throw new ProjectStoreError("DUPLICATE_ID", `Project '${entry.id}' already exists`);
      }
      const realPath = expandHome(entry.path);
      if (!fs.existsSync(realPath)) {
        throw new ProjectStoreError("PATH_NOT_FOUND", `Path '${entry.path}' does not exist`);
      }
      if (entry.isDefault) {
        const projects = listProjectsFromDb();
        const existingDefault = projects.find((e) => e.isDefault);
        if (existingDefault) {
          throw new ProjectStoreError(
            "MULTIPLE_DEFAULTS",
            `Only one project can be default; '${existingDefault.id}' is already default`,
          );
        }
      }
      insertProjectToDb(entry);
    },

    async update(id: string, patch: Partial<ProjectEntry>) {
      const existing = getProjectFromDb(id);
      if (!existing) {
        throw new ProjectStoreError("PROJECT_NOT_FOUND", `No project with id '${id}'`);
      }
      if (patch.isDefault === true) {
        const projects = listProjectsFromDb();
        const existingDefault = projects.find((e) => e.isDefault && e.id !== id);
        if (existingDefault) {
          throw new ProjectStoreError(
            "MULTIPLE_DEFAULTS",
            `Only one project can be default; '${existingDefault.id}' is already default`,
          );
        }
      }
      updateProjectInDb(id, patch);
    },

    async archive(id: string) {
      const existing = getProjectFromDb(id);
      if (!existing) {
        throw new ProjectStoreError("PROJECT_NOT_FOUND", `No project with id '${id}'`);
      }
      updateProjectInDb(id, { status: "archived", isDefault: false });
    },
  };
}
