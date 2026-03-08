import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { updateSessionStore } from "../../config/sessions.js";
import { resolveGatewaySessionStoreTarget } from "../session-utils.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { ProjectEntry, ProjectDetails, ProjectStore } from "./projects.types.js";
import type { GatewayRequestHandlers } from "./types.js";

// ── Session Bindings (in-memory, not persisted) ─────────────────────

const sessionBindings = new Map<string, string>();

// ── MarkdownProjectStore ────────────────────────────────────────────

function resolveProjectsPath(): string {
  const cfg = loadConfig();
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  return path.join(workspaceDir, "PROJECTS.md");
}

/**
 * Parse a PROJECTS.md file into ProjectEntry objects.
 *
 * Expected format:
 * ```
 * # Active Projects
 *
 * ## project-id
 * - **Path:** ~/dev/project
 * - **Type:** web app
 * - **Tech:** TypeScript, React
 * - **Status:** Active development
 * - **Default:** true
 * - **Keywords:** keyword1, keyword2
 *
 * # Archived Projects
 *
 * ## old-project
 * ...
 * ```
 */
function parseProjectsMd(content: string): ProjectEntry[] {
  const entries: ProjectEntry[] = [];
  const lines = content.split("\n");

  let currentId: string | null = null;
  let current: Partial<ProjectEntry> = {};
  let inTelegramBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // H2 = project ID
    const h2Match = trimmed.match(/^## (.+)$/);
    if (h2Match) {
      // Save previous entry if any
      if (currentId && current.path) {
        entries.push(finalizeEntry(currentId, current));
      }
      currentId = h2Match[1].trim();
      current = {};
      inTelegramBlock = false;
      continue;
    }

    // H1 resets (e.g., "# Archived Projects")
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

    // Parse nested Telegram sub-fields (e.g., "  - Group: Operator1 Group", "  - Topic: 41")
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
      // Non-sub-item line exits the telegram block
      inTelegramBlock = false;
    }

    // Parse bullet fields
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

  // Don't forget the last entry
  if (currentId && current.path) {
    entries.push(finalizeEntry(currentId, current));
  }

  return entries;
}

function finalizeEntry(id: string, partial: Partial<ProjectEntry>): ProjectEntry {
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

function serializeProjectsMd(entries: ProjectEntry[]): string {
  const active = entries.filter((e) => e.status !== "archived");
  const archived = entries.filter((e) => e.status === "archived");

  let md = "# Active Projects\n";

  for (const e of active) {
    md += `\n## ${e.id}\n`;
    if (e.name && e.name !== e.id) {
      md += `- **Name:** ${e.name}\n`;
    }
    md += `- **Path:** ${e.path}\n`;
    md += `- **Type:** ${e.type}\n`;
    md += `- **Tech:** ${e.tech}\n`;
    md += `- **Status:** ${e.status}\n`;
    if (e.isDefault) {
      md += `- **Default:** true\n`;
    }
    if (e.keywords.length > 0) {
      md += `- **Keywords:** ${e.keywords.join(", ")}\n`;
    }
    if (e.telegram) {
      md += `- **Telegram:**\n`;
      if (e.telegram.group) {
        md += `  - Group: ${e.telegram.group}\n`;
      }
      if (e.telegram.topicId !== undefined) {
        md += `  - Topic: ${e.telegram.topicId}\n`;
      }
    }
  }

  if (archived.length > 0) {
    md += "\n# Archived Projects\n";
    for (const e of archived) {
      md += `\n## ${e.id}\n`;
      if (e.name && e.name !== e.id) {
        md += `- **Name:** ${e.name}\n`;
      }
      md += `- **Path:** ${e.path}\n`;
      md += `- **Type:** ${e.type}\n`;
      md += `- **Tech:** ${e.tech}\n`;
      md += `- **Status:** ${e.status}\n`;
      if (e.keywords.length > 0) {
        md += `- **Keywords:** ${e.keywords.join(", ")}\n`;
      }
    }
  }

  return md;
}

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

function createMarkdownProjectStore(): ProjectStore {
  const filePath = resolveProjectsPath();

  function readEntries(): ProjectEntry[] {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      return parseProjectsMd(content);
    } catch {
      return [];
    }
  }

  function writeEntries(entries: ProjectEntry[]): void {
    fs.writeFileSync(filePath, serializeProjectsMd(entries), "utf8");
  }

  return {
    async list() {
      return readEntries();
    },

    async get(id: string) {
      const entries = readEntries();
      const entry = entries.find((e) => e.id === id);
      if (!entry) {
        throw new ProjectStoreError("PROJECT_NOT_FOUND", `No project with id '${id}'`);
      }

      const projectPath = expandHome(entry.path);
      const openclawDir = path.join(projectPath, ".openclaw");

      if (!fs.existsSync(openclawDir)) {
        throw new ProjectStoreError(
          "NO_WORKSPACE",
          `Project '${id}' has no .openclaw/ directory at ${entry.path}`,
        );
      }

      const details: ProjectDetails = {
        ...entry,
        soul: readOptionalFile(path.join(openclawDir, "SOUL.md")),
        agents: readOptionalFile(path.join(openclawDir, "AGENTS.md")),
        tools: readOptionalFile(path.join(openclawDir, "TOOLS.md")),
      };

      return details;
    },

    async add(entry: ProjectEntry) {
      const entries = readEntries();
      if (entries.some((e) => e.id === entry.id)) {
        throw new ProjectStoreError("DUPLICATE_ID", `Project '${entry.id}' already exists`);
      }
      const realPath = expandHome(entry.path);
      if (!fs.existsSync(realPath)) {
        throw new ProjectStoreError("PATH_NOT_FOUND", `Path '${entry.path}' does not exist`);
      }
      if (entry.isDefault) {
        const existingDefault = entries.find((e) => e.isDefault);
        if (existingDefault) {
          throw new ProjectStoreError(
            "MULTIPLE_DEFAULTS",
            `Only one project can be default; '${existingDefault.id}' is already default`,
          );
        }
      }
      entries.push(entry);
      writeEntries(entries);
    },

    async update(id: string, patch: Partial<ProjectEntry>) {
      const entries = readEntries();
      const idx = entries.findIndex((e) => e.id === id);
      if (idx === -1) {
        throw new ProjectStoreError("PROJECT_NOT_FOUND", `No project with id '${id}'`);
      }

      if (patch.isDefault === true) {
        const existingDefault = entries.find((e) => e.isDefault && e.id !== id);
        if (existingDefault) {
          throw new ProjectStoreError(
            "MULTIPLE_DEFAULTS",
            `Only one project can be default; '${existingDefault.id}' is already default`,
          );
        }
      }

      entries[idx] = { ...entries[idx], ...patch, id };
      writeEntries(entries);
    },

    async archive(id: string) {
      const entries = readEntries();
      const idx = entries.findIndex((e) => e.id === id);
      if (idx === -1) {
        throw new ProjectStoreError("PROJECT_NOT_FOUND", `No project with id '${id}'`);
      }

      entries[idx].status = "archived";
      entries[idx].isDefault = false;
      writeEntries(entries);
    },
  };
}

class ProjectStoreError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ProjectStoreError";
  }
}

// ── Session ProjectId Persistence ───────────────────────────────────

/** Persist projectId on the session record (fire-and-forget). */
function persistProjectId(sessionKey: string, projectId: string | null): void {
  try {
    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key: sessionKey });
    void updateSessionStore(target.storePath, async (store) => {
      const entry = store[sessionKey] ?? store[target.canonicalKey ?? sessionKey];
      if (!entry) {
        return { ok: true, entry: {} as import("../../config/sessions/types.js").SessionEntry };
      }
      if (projectId === null) {
        delete entry.projectId;
      } else {
        entry.projectId = projectId;
      }
      return { ok: true, entry };
    });
  } catch {
    // Best-effort — don't break bind/unbind if session store is unavailable
  }
}

/** Read persisted projectId from session record (for rehydrating after restart). */
function readPersistedProjectId(sessionKey: string): string | undefined {
  try {
    const cfg = loadConfig();
    const target = resolveGatewaySessionStoreTarget({ cfg, key: sessionKey });
    const storePath = target.storePath;
    const raw = fs.readFileSync(storePath, "utf8");
    const store = JSON.parse(raw) as Record<string, { projectId?: string }>;
    const entry = store[sessionKey] ?? store[target.canonicalKey ?? sessionKey];
    return entry?.projectId;
  } catch {
    return undefined;
  }
}

// ── Internal Project Tasks Scanner ──────────────────────────────────

/**
 * Scan the default project's internal Projects/ directory for sub-projects.
 * These are directories (not .md files) that represent internal project workspaces.
 */
function scanInternalProjectTasks(registeredProjects: ProjectEntry[]): ProjectEntry[] {
  const defaultProject = registeredProjects.find((p) => p.isDefault);
  if (!defaultProject) {
    return [];
  }
  const projectsDir = path.join(expandHome(defaultProject.path), "Projects");
  try {
    if (!fs.existsSync(projectsDir)) {
      return [];
    }
    const entries: ProjectEntry[] = [];
    const registeredIds = new Set(registeredProjects.map((p) => p.id));
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const dirent of dirs) {
      if (!dirent.isDirectory() || dirent.name.startsWith(".")) {
        continue;
      }
      const id = dirent.name;
      // Skip if already registered in PROJECTS.md
      if (registeredIds.has(id)) {
        continue;
      }
      const dirPath = path.join(projectsDir, id);
      entries.push({
        id,
        name: id,
        path: dirPath,
        type: "internal",
        tech: "",
        status: "active",
        isDefault: false,
        keywords: [],
      });
    }
    return entries;
  } catch {
    return [];
  }
}

// ── Gateway Handlers ────────────────────────────────────────────────

let _store: ProjectStore | undefined;
function getStore(): ProjectStore {
  if (!_store) {
    _store = createMarkdownProjectStore();
  }
  return _store;
}

export const projectsHandlers: GatewayRequestHandlers = {
  "projects.list": async ({ respond }) => {
    try {
      const projects = await getStore().list();
      const internal = scanInternalProjectTasks(projects);
      respond(true, { projects: [...projects, ...internal] }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "projects.get": async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }
    try {
      const project = await getStore().get(id);
      respond(true, project, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "projects.add": async ({ params, respond }) => {
    const p = params;
    const id = typeof p.id === "string" ? p.id.trim() : "";
    const projectPath = typeof p.path === "string" ? p.path.trim() : "";
    if (!id || !projectPath) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id and path are required"));
      return;
    }
    const entry: ProjectEntry = {
      id,
      name: typeof p.name === "string" ? p.name.trim() : id,
      path: projectPath,
      type: typeof p.type === "string" ? p.type.trim() : "",
      tech: typeof p.tech === "string" ? p.tech.trim() : "",
      status: typeof p.status === "string" ? p.status.trim() : "active",
      isDefault: p.isDefault === true,
      keywords: Array.isArray(p.keywords)
        ? (p.keywords as unknown[]).filter((k): k is string => typeof k === "string")
        : [],
    };
    try {
      await getStore().add(entry);
      respond(true, { ok: true, id }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "projects.update": async ({ params, respond }) => {
    const p = params;
    const id = typeof p.id === "string" ? p.id.trim() : "";
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }
    const patch: Partial<ProjectEntry> = {};
    if (typeof p.name === "string") {
      patch.name = p.name.trim();
    }
    if (typeof p.path === "string") {
      patch.path = p.path.trim();
    }
    if (typeof p.type === "string") {
      patch.type = p.type.trim();
    }
    if (typeof p.tech === "string") {
      patch.tech = p.tech.trim();
    }
    if (typeof p.status === "string") {
      patch.status = p.status.trim();
    }
    if (typeof p.isDefault === "boolean") {
      patch.isDefault = p.isDefault;
    }
    if (Array.isArray(p.keywords)) {
      patch.keywords = (p.keywords as unknown[]).filter((k): k is string => typeof k === "string");
    }
    try {
      await getStore().update(id, patch);
      respond(true, { ok: true, id }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "projects.archive": async ({ params, respond }) => {
    const id = typeof params.id === "string" ? params.id.trim() : "";
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }
    try {
      await getStore().archive(id);
      respond(true, { ok: true, id }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "projects.bindSession": async ({ params, respond }) => {
    const p = params;
    const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
    const projectId = typeof p.projectId === "string" ? p.projectId.trim() : "";
    if (!sessionKey || !projectId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey and projectId are required"),
      );
      return;
    }
    try {
      const project = await getStore().get(projectId);
      sessionBindings.set(sessionKey, projectId);
      // Persist projectId on the session record so it survives gateway restarts
      persistProjectId(sessionKey, projectId);
      const injectedMessage = `[Session Init] Active project: ${projectId} | Path: ${project.path}`;
      respond(true, { projectId, path: project.path, injectedMessage }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "projects.unbindSession": ({ params, respond }) => {
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
      return;
    }
    sessionBindings.delete(sessionKey);
    // Clear persisted projectId from session record
    persistProjectId(sessionKey, null);
    respond(true, { ok: true }, undefined);
  },

  "projects.getContext": async ({ params, respond }) => {
    const sessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey is required"));
      return;
    }
    // Check in-memory cache, persisted record, then auto-bind by topic
    let projectId = sessionBindings.get(sessionKey);
    if (!projectId) {
      projectId = readPersistedProjectId(sessionKey);
      if (projectId) {
        sessionBindings.set(sessionKey, projectId);
      }
    }
    if (!projectId) {
      projectId = await autoBindByTopicFromSessionKey(sessionKey);
    }
    if (!projectId) {
      respond(true, null, undefined);
      return;
    }
    try {
      const entries = await getStore().list();
      const project = entries.find((e) => e.id === projectId) ?? null;
      respond(true, project, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },
};

// ── Exported Helper ─────────────────────────────────────────────────

/**
 * Resolve project details for a session, checking in-memory bindings first,
 * then persisted session record, then auto-matching by Telegram topic ID.
 * Returns null if no project is bound or if the project cannot be loaded.
 */
export async function getProjectContextForSession(
  sessionKey: string,
): Promise<ProjectDetails | null> {
  let projectId = sessionBindings.get(sessionKey);
  if (!projectId) {
    projectId = readPersistedProjectId(sessionKey);
    if (projectId) {
      sessionBindings.set(sessionKey, projectId);
    }
  }
  // Auto-bind by Telegram topic if no explicit binding exists
  if (!projectId) {
    projectId = await autoBindByTopicFromSessionKey(sessionKey);
  }
  if (!projectId) {
    return null;
  }
  try {
    return await getStore().get(projectId);
  } catch {
    return null;
  }
}

/**
 * Try to auto-bind a session to a project based on Telegram topic ID.
 * Session keys for Telegram topics look like:
 *   agent:{agentId}:telegram:direct:{peerId}:thread:{topicId}
 *   or contain `:thread:{chatId}:{topicId}`
 * If a project in PROJECTS.md has a matching telegram.topicId, auto-bind and persist.
 */
async function autoBindByTopicFromSessionKey(sessionKey: string): Promise<string | undefined> {
  // Extract topic ID from session key patterns
  const threadMatch = sessionKey.match(/:thread:(?:\d+:)?(\d+)$/);
  if (!threadMatch) {
    return undefined;
  }
  const topicId = parseInt(threadMatch[1], 10);
  if (isNaN(topicId)) {
    return undefined;
  }
  try {
    const projects = await getStore().list();
    const matched = projects.find((p) => p.telegram?.topicId === topicId);
    if (!matched) {
      return undefined;
    }
    // Auto-bind: set in-memory + persist
    sessionBindings.set(sessionKey, matched.id);
    persistProjectId(sessionKey, matched.id);
    return matched.id;
  } catch {
    return undefined;
  }
}

function storeErrorToShape(err: unknown) {
  if (err instanceof ProjectStoreError) {
    return errorShape(ErrorCodes.INVALID_REQUEST, err.message, { details: { code: err.code } });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}
