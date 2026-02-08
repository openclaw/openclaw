import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type ReflectionEntryV0 = {
  version: 0;
  id: string;
  createdAt: string;
  /** Short label for quick scanning (optional). */
  title?: string;
  /** Freeform markdown/text content. */
  body: string;
  tags?: string[];
};

export type ReflectionStore = {
  /** Resolve state dir override (tests). */
  env?: NodeJS.ProcessEnv;
};

export function resolveReflectionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return path.join(stateDir, "reflections");
}

export function resolveReflectionsJsonlPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveReflectionsDir(env), "reflections.jsonl");
}

function safeParseJsonLine(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function normalizeTags(tags: unknown): string[] | undefined {
  if (!Array.isArray(tags)) {
    return undefined;
  }
  const out = tags
    .map((t) => String(t ?? "").trim())
    .filter(Boolean)
    .slice(0, 50);
  return out.length ? out : undefined;
}

function normalizeEntry(obj: unknown): ReflectionEntryV0 | null {
  if (!obj || typeof obj !== "object") {
    return null;
  }
  const rec = obj as Record<string, unknown>;
  const version = rec.version;
  if (version !== 0) {
    return null;
  }
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  const createdAt = typeof rec.createdAt === "string" ? rec.createdAt.trim() : "";
  const body = typeof rec.body === "string" ? rec.body : "";
  if (!id || !createdAt || !body) {
    return null;
  }
  const title = typeof rec.title === "string" ? rec.title.trim() : undefined;
  const tags = normalizeTags(rec.tags);
  return {
    version: 0,
    id,
    createdAt,
    ...(title ? { title } : {}),
    body,
    ...(tags ? { tags } : {}),
  };
}

async function ensureParentDir(filePath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

export async function addReflection(params: {
  body: string;
  title?: string;
  tags?: string[];
  env?: NodeJS.ProcessEnv;
  id?: string;
  createdAt?: string;
}): Promise<ReflectionEntryV0> {
  const env = params.env ?? process.env;
  const filePath = resolveReflectionsJsonlPath(env);
  await ensureParentDir(filePath);

  const body = params.body;
  if (!body || !body.trim()) {
    throw new Error("reflection body required");
  }

  const createdAt = params.createdAt ?? new Date().toISOString();
  const id = (params.id ?? crypto.randomUUID()).trim();
  if (!id) {
    throw new Error("reflection id required");
  }

  const title = params.title?.trim() || undefined;
  const tags = params.tags?.map((t) => String(t).trim()).filter(Boolean);

  const entry: ReflectionEntryV0 = {
    version: 0,
    id,
    createdAt,
    ...(title ? { title } : {}),
    body,
    ...(tags && tags.length ? { tags } : {}),
  };

  // Append-only JSONL. One entry per line.
  await fs.promises.appendFile(filePath, `${JSON.stringify(entry)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });

  return entry;
}

export async function listReflections(
  params: {
    env?: NodeJS.ProcessEnv;
    limit?: number;
  } = {},
): Promise<ReflectionEntryV0[]> {
  const env = params.env ?? process.env;
  const filePath = resolveReflectionsJsonlPath(env);
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const entries: ReflectionEntryV0[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parsed = safeParseJsonLine(line);
    if (!parsed) {
      continue;
    }
    const normalized = normalizeEntry(parsed);
    if (normalized) {
      entries.push(normalized);
    }
  }

  // Newest first.
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const limit = params.limit;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    return entries.slice(0, limit);
  }
  return entries;
}

export async function getReflection(params: {
  id: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ReflectionEntryV0 | null> {
  const id = params.id.trim();
  if (!id) {
    return null;
  }
  const entries = await listReflections({ env: params.env });
  return entries.find((e) => e.id === id) ?? null;
}
