import fs from "node:fs/promises";
import path from "node:path";
import { buildFileEntry, type MemoryFileEntry } from "./internal.js";

export type TaskMemoryAction = "enqueue" | "claim" | "complete" | "reassign";

export type AppendTaskMemoryEventParams = {
  workspaceDir: string;
  agentId: string;
  action: TaskMemoryAction;
  task?: string;
  owner?: string;
  actor?: string;
  loopId?: string;
  title?: string;
  result?: string;
  note?: string;
};

function sanitizeSegment(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const sanitized = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "main";
}

function sanitizeLine(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 0 ? compact : null;
}

export function resolveTaskMemoryDir(workspaceDir: string): string {
  return path.join(workspaceDir, "memory", "tasks");
}

export function resolveTaskMemoryMarkdownPath(workspaceDir: string, agentId: string): string {
  return path.join(resolveTaskMemoryDir(workspaceDir), `${sanitizeSegment(agentId)}.md`);
}

export async function buildTaskMemoryEntry(
  workspaceDir: string,
  agentId: string,
): Promise<MemoryFileEntry | null> {
  const absPath = resolveTaskMemoryMarkdownPath(workspaceDir, agentId);
  return await buildFileEntry(absPath, workspaceDir);
}

export async function countTaskMemoryFiles(workspaceDir: string): Promise<number> {
  const dir = resolveTaskMemoryDir(workspaceDir);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).length;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return 0;
    }
    throw err;
  }
}

export async function appendTaskMemoryEvent(params: AppendTaskMemoryEventParams): Promise<string> {
  const dir = resolveTaskMemoryDir(params.workspaceDir);
  await fs.mkdir(dir, { recursive: true });
  const filePath = resolveTaskMemoryMarkdownPath(params.workspaceDir, params.agentId);

  const timestamp = new Date().toISOString();
  const actionLabel = params.action.toUpperCase();
  const taskLabel = sanitizeLine(params.task) ?? "(task-not-specified)";

  const details: string[] = [];
  const fields: Array<[string, string | null]> = [
    ["title", sanitizeLine(params.title)],
    ["owner", sanitizeLine(params.owner)],
    ["actor", sanitizeLine(params.actor)],
    ["loop", sanitizeLine(params.loopId)],
    ["result", sanitizeLine(params.result)],
    ["note", sanitizeLine(params.note)],
  ];
  for (const [label, value] of fields) {
    if (!value) {
      continue;
    }
    details.push(`- ${label}: ${value}`);
  }

  const block = [`## ${timestamp} · ${actionLabel} · ${taskLabel}`, ...details, ""].join("\n");
  await fs.appendFile(filePath, `${block}\n`, "utf-8");
  return filePath;
}
