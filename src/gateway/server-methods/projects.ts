import fs from "node:fs";
import path from "node:path";
import {
  updateSessionProjectId,
  readSessionProjectId,
} from "../../config/sessions/store-sqlite.js";
import {
  getCoreSettingFromDb,
  setCoreSettingInDb,
} from "../../infra/state-db/core-settings-sqlite.js";
import {
  createSqliteProjectStore,
  ProjectStoreError,
} from "../../projects/project-store-sqlite.js";
import {
  findProjectByTopicId,
  getBindingsForProject,
  bindTelegramTopic,
  unbindTelegramTopic,
} from "../../projects/telegram-topic-binding-sqlite.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { ProjectEntry, ProjectDetails, ProjectStore } from "./projects.types.js";
import type { GatewayRequestHandlers } from "./types.js";

// ── Session Bindings (in-memory, not persisted) ─────────────────────

const sessionBindings = new Map<string, string>();

// ── Helpers ─────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(process.env.HOME ?? "/", p.slice(2));
  }
  return p;
}

// ── Session ProjectId Persistence (SQLite) ──────────────────────────

/** Persist projectId on the session_entries row (fire-and-forget). */
function persistProjectId(sessionKey: string, projectId: string | null): void {
  try {
    updateSessionProjectId(sessionKey, projectId);
  } catch {
    // Best-effort — don't break bind/unbind if DB is unavailable
  }
}

/** Read persisted projectId from session_entries (for rehydrating after restart). */
function readPersistedProjectId(sessionKey: string): string | undefined {
  return readSessionProjectId(sessionKey);
}

// ── Root Path Setting ────────────────────────────────────────────────

const PROJECTS_SCOPE = "projects";
const ROOT_PATH_KEY = "rootPath";

function getRootPath(): string {
  return getCoreSettingFromDb<string>(PROJECTS_SCOPE, ROOT_PATH_KEY) ?? "";
}

function setRootPath(rootPath: string): void {
  setCoreSettingInDb(PROJECTS_SCOPE, ROOT_PATH_KEY, rootPath);
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
    _store = createSqliteProjectStore();
  }
  return _store;
}

export const projectsHandlers: GatewayRequestHandlers = {
  "projects.list": async ({ respond }) => {
    try {
      const projects = await getStore().list();
      const internal = scanInternalProjectTasks(projects);
      const rootPath = expandHome(getRootPath());
      // Normalize ~/… paths to absolute so frontend scope comparison is consistent
      const allProjects = [...projects, ...internal].map((p) => ({
        ...p,
        path: expandHome(p.path),
      }));
      respond(true, { projects: allProjects, rootPath }, undefined);
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
      projectId = autoBindByTopicFromSessionKey(sessionKey);
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

  // ── Telegram Topic Binding RPCs ─────────────────────────────────────

  "projects.bindTelegramTopic": async ({ params, respond }) => {
    const projectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
    const chatId = typeof params.chatId === "string" ? params.chatId.trim() : "";
    const topicId =
      typeof params.topicId === "string"
        ? params.topicId.trim()
        : typeof params.topicId === "number"
          ? `${params.topicId}`
          : "";
    if (!projectId || !chatId || !topicId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "projectId, chatId, and topicId are required"),
      );
      return;
    }
    try {
      // Verify project exists
      await getStore().get(projectId);
      bindTelegramTopic({
        chatId,
        topicId,
        projectId,
        groupName: typeof params.groupName === "string" ? params.groupName : undefined,
        topicName: typeof params.topicName === "string" ? params.topicName : undefined,
        boundBy: typeof params.boundBy === "string" ? params.boundBy : "manual",
      });
      respond(true, { ok: true, chatId, topicId, projectId }, undefined);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "projects.unbindTelegramTopic": async ({ params, respond }) => {
    const chatId = typeof params.chatId === "string" ? params.chatId.trim() : "";
    const topicId =
      typeof params.topicId === "string"
        ? params.topicId.trim()
        : typeof params.topicId === "number"
          ? `${params.topicId}`
          : "";
    if (!chatId || !topicId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "chatId and topicId are required"),
      );
      return;
    }
    const removed = unbindTelegramTopic(chatId, topicId);
    if (!removed) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "binding not found"));
      return;
    }
    respond(true, { ok: true, chatId, topicId }, undefined);
  },

  // ── Root Path RPCs ─────────────────────────────────────────────────

  "projects.getRootPath": ({ respond }) => {
    respond(true, { rootPath: getRootPath() }, undefined);
  },

  "projects.setRootPath": ({ params, respond }) => {
    const rootPath = typeof params.rootPath === "string" ? params.rootPath.trim() : "";
    if (rootPath && !fs.existsSync(expandHome(rootPath))) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `Path does not exist: ${rootPath}`),
      );
      return;
    }
    setRootPath(rootPath);
    respond(true, { ok: true, rootPath }, undefined);
  },

  "projects.getTelegramBindings": async ({ params, respond }) => {
    const projectId = typeof params.projectId === "string" ? params.projectId.trim() : "";
    if (!projectId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "projectId is required"));
      return;
    }
    const bindings = getBindingsForProject(projectId);
    respond(true, { bindings }, undefined);
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
    projectId = autoBindByTopicFromSessionKey(sessionKey);
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
 * Uses SQLite topic bindings table instead of scanning PROJECTS.md.
 */
function autoBindByTopicFromSessionKey(sessionKey: string): string | undefined {
  // Extract topic ID from session key patterns
  const threadMatch = sessionKey.match(/:thread:(?:\d+:)?(\d+)$/);
  if (!threadMatch) {
    return undefined;
  }
  const topicId = threadMatch[1];

  // Query SQLite for a matching topic binding
  const projectId = findProjectByTopicId(topicId);
  if (!projectId) {
    return undefined;
  }

  // Auto-bind: set in-memory + persist
  sessionBindings.set(sessionKey, projectId);
  persistProjectId(sessionKey, projectId);
  return projectId;
}

function storeErrorToShape(err: unknown) {
  if (err instanceof ProjectStoreError) {
    return errorShape(ErrorCodes.INVALID_REQUEST, err.message, { details: { code: err.code } });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}
