import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { resolveDefaultAgentId, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { readJsonBody } from "./hooks.js";

const MAX_TASKS_BODY_BYTES = 512 * 1024;

export type TaskStatus = "upcoming" | "in_progress" | "done";
export type TaskPriority = "P0" | "P1" | "P2" | "P3";

export type Task = {
  id: string;
  title: string;
  status: TaskStatus;
  priority?: TaskPriority;
  tags?: string[];
  dueAt?: string | null;
  createdAt?: string;
  startedAt?: string | null;
  doneAt?: string | null;
  notes?: string | null;
};

type TaskStore = {
  updatedAt: string | null;
  tasks: Task[];
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(JSON.stringify(body));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeStatus(value: unknown): TaskStatus {
  return value === "in_progress" || value === "done" ? value : "upcoming";
}

function normalizePriority(value: unknown): TaskPriority | undefined {
  return value === "P0" || value === "P1" || value === "P2" || value === "P3" ? value : undefined;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean)
    .slice(0, 32);
  return out.length ? out : undefined;
}

function normalizeIsoOrNull(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const s = value.trim();
  if (!s) {
    return null;
  }
  // light validation
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    return undefined;
  }
  return s;
}

function normalizeText(value: unknown, maxLen = 20_000): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const s = value.trim();
  if (!s) {
    return null;
  }
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

async function ensureStoreFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.stat(filePath);
  } catch {
    const initial: TaskStore = { updatedAt: null, tasks: [] };
    await fs.writeFile(filePath, JSON.stringify(initial, null, 2) + "\n", "utf-8");
  }
}

async function readStore(filePath: string): Promise<TaskStore> {
  await ensureStoreFile(filePath);
  const raw = await fs.readFile(filePath, "utf-8");
  try {
    const parsed = JSON.parse(raw) as Partial<TaskStore> | null;
    const tasks = Array.isArray(parsed?.tasks) ? parsed?.tasks : [];
    const updatedAt =
      typeof parsed?.updatedAt === "string" || parsed?.updatedAt === null ? parsed.updatedAt : null;
    return { updatedAt, tasks };
  } catch {
    return { updatedAt: null, tasks: [] };
  }
}

async function writeStore(filePath: string, store: TaskStore): Promise<void> {
  store.updatedAt = nowIso();
  await ensureStoreFile(filePath);
  await fs.writeFile(filePath, JSON.stringify(store, null, 2) + "\n", "utf-8");
}

function tasksFilePath(cfg: OpenClawConfig) {
  const agentId = resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  return path.join(workspaceDir, "task-dashboard", "tasks.json");
}

export async function handleTasksHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  params: { cfg: OpenClawConfig; basePath?: string },
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  const url = new URL(urlRaw, "http://localhost");
  const base = params.basePath?.trim() ? params.basePath.trim().replace(/\/+$/, "") : "";
  const prefix = base ? `${base}/api/tasks` : "/api/tasks";
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
    return false;
  }

  const filePath = tasksFilePath(params.cfg);

  // GET /api/tasks
  if (req.method === "GET") {
    const store = await readStore(filePath);
    sendJson(res, 200, store);
    return true;
  }

  // PUT /api/tasks (replace entire store)
  if (req.method === "PUT" && url.pathname === prefix) {
    const body = await readJsonBody(req, MAX_TASKS_BODY_BYTES);
    if (!body.ok || typeof body.value !== "object" || !body.value) {
      sendJson(res, 400, { ok: false, error: body.ok ? "invalid json" : body.error });
      return true;
    }
    const value = body.value as Record<string, unknown>;
    const tasks = Array.isArray(value.tasks) ? value.tasks : [];
    // sanitize tasks shallowly
    const cleaned: Task[] = [];
    for (const t of tasks) {
      if (!t || typeof t !== "object") {
        continue;
      }
      const obj = t as Record<string, unknown>;
      const id = typeof obj.id === "string" ? obj.id.trim() : "";
      const title = typeof obj.title === "string" ? obj.title.trim() : "";
      if (!id || !title) {
        continue;
      }
      cleaned.push({
        id,
        title,
        status: normalizeStatus(obj.status),
        priority: normalizePriority(obj.priority),
        tags: normalizeTags(obj.tags),
        dueAt: normalizeIsoOrNull(obj.dueAt) ?? undefined,
        createdAt: typeof obj.createdAt === "string" ? obj.createdAt : undefined,
        startedAt: normalizeIsoOrNull(obj.startedAt) ?? undefined,
        doneAt: normalizeIsoOrNull(obj.doneAt) ?? undefined,
        notes: normalizeText(obj.notes) ?? undefined,
      });
    }
    const next: TaskStore = { updatedAt: null, tasks: cleaned };
    await writeStore(filePath, next);
    sendJson(res, 200, { ok: true, store: next });
    return true;
  }

  // POST /api/tasks (create)
  if (req.method === "POST" && url.pathname === prefix) {
    const body = await readJsonBody(req, MAX_TASKS_BODY_BYTES);
    if (!body.ok || typeof body.value !== "object" || !body.value) {
      sendJson(res, 400, { ok: false, error: body.ok ? "invalid json" : body.error });
      return true;
    }
    const value = body.value as Record<string, unknown>;
    const title = typeof value.title === "string" ? value.title.trim() : "";
    if (!title) {
      sendJson(res, 400, { ok: false, error: "title required" });
      return true;
    }
    const store = await readStore(filePath);
    const task: Task = {
      id: randomUUID(),
      title,
      status: normalizeStatus(value.status),
      priority: normalizePriority(value.priority),
      tags: normalizeTags(value.tags),
      dueAt: normalizeIsoOrNull(value.dueAt) ?? undefined,
      createdAt: nowIso(),
      startedAt: normalizeIsoOrNull(value.startedAt) ?? undefined,
      doneAt: normalizeIsoOrNull(value.doneAt) ?? undefined,
      notes: normalizeText(value.notes) ?? undefined,
    };
    store.tasks.unshift(task);
    await writeStore(filePath, store);
    sendJson(res, 200, { ok: true, task, store });
    return true;
  }

  // PATCH /api/tasks/:id (update)
  if (req.method === "PATCH" && url.pathname.startsWith(`${prefix}/`)) {
    const id = url.pathname.slice(`${prefix}/`.length).trim();
    if (!id) {
      sendJson(res, 400, { ok: false, error: "missing id" });
      return true;
    }
    const body = await readJsonBody(req, MAX_TASKS_BODY_BYTES);
    if (!body.ok || typeof body.value !== "object" || !body.value) {
      sendJson(res, 400, { ok: false, error: body.ok ? "invalid json" : body.error });
      return true;
    }
    const patch = body.value as Record<string, unknown>;
    const store = await readStore(filePath);
    const idx = store.tasks.findIndex((t) => t.id === id);
    if (idx < 0) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return true;
    }
    const current = store.tasks[idx];
    const next: Task = {
      ...current,
      title: typeof patch.title === "string" ? patch.title.trim() || current.title : current.title,
      status: patch.status ? normalizeStatus(patch.status) : current.status,
      priority: patch.priority
        ? (normalizePriority(patch.priority) ?? current.priority)
        : current.priority,
      tags: patch.tags ? (normalizeTags(patch.tags) ?? current.tags) : current.tags,
      dueAt:
        patch.dueAt !== undefined
          ? (normalizeIsoOrNull(patch.dueAt) ?? current.dueAt ?? null)
          : current.dueAt,
      startedAt:
        patch.startedAt !== undefined
          ? (normalizeIsoOrNull(patch.startedAt) ?? current.startedAt ?? null)
          : current.startedAt,
      doneAt:
        patch.doneAt !== undefined
          ? (normalizeIsoOrNull(patch.doneAt) ?? current.doneAt ?? null)
          : current.doneAt,
      notes:
        patch.notes !== undefined
          ? (normalizeText(patch.notes) ?? current.notes ?? null)
          : current.notes,
    };

    // Set startedAt/doneAt automatically for common transitions.
    if (current.status !== "in_progress" && next.status === "in_progress" && !next.startedAt) {
      next.startedAt = nowIso();
    }
    if (current.status !== "done" && next.status === "done" && !next.doneAt) {
      next.doneAt = nowIso();
    }

    store.tasks[idx] = next;
    await writeStore(filePath, store);
    sendJson(res, 200, { ok: true, task: next, store });
    return true;
  }

  // DELETE /api/tasks/:id
  if (req.method === "DELETE" && url.pathname.startsWith(`${prefix}/`)) {
    const id = url.pathname.slice(`${prefix}/`.length).trim();
    if (!id) {
      sendJson(res, 400, { ok: false, error: "missing id" });
      return true;
    }
    const store = await readStore(filePath);
    const before = store.tasks.length;
    store.tasks = store.tasks.filter((t) => t.id !== id);
    if (store.tasks.length === before) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return true;
    }
    await writeStore(filePath, store);
    sendJson(res, 200, { ok: true, store });
    return true;
  }

  sendJson(res, 405, { ok: false, error: "method not allowed" });
  return true;
}
