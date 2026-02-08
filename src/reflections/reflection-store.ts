import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type ReflectionEntry = {
  id: string;
  createdAt: string;
  title: string;
  context?: string;
  whatWorked?: string;
  whatDidnt?: string;
  nextTime?: string;
  tags?: string[];
  related?: Record<string, string>;
  meta: {
    cwd: string;
    hostname: string;
    platform: NodeJS.Platform;
    openclawVersion?: string;
  };
};

export type ReflectionCreateInput = {
  title: string;
  context?: string;
  whatWorked?: string;
  whatDidnt?: string;
  nextTime?: string;
  tags?: string[];
  related?: Record<string, string>;
};

function normalizeTags(tags: string[] | undefined): string[] | undefined {
  if (!tags?.length) {
    return undefined;
  }
  const normalized = tags
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => t.toLowerCase());
  if (!normalized.length) {
    return undefined;
  }
  return Array.from(new Set(normalized));
}

export function resolveReflectionsPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return path.join(stateDir, "reflections.jsonl");
}

export async function appendReflection(params: {
  input: ReflectionCreateInput;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  cwd?: () => string;
  hostname?: () => string;
  platform?: NodeJS.Platform;
  openclawVersion?: string;
}): Promise<ReflectionEntry> {
  const env = params.env ?? process.env;
  const now = params.now ?? (() => new Date());
  const entry: ReflectionEntry = {
    id: crypto.randomUUID(),
    createdAt: now().toISOString(),
    title: params.input.title,
    context: params.input.context?.trim() || undefined,
    whatWorked: params.input.whatWorked?.trim() || undefined,
    whatDidnt: params.input.whatDidnt?.trim() || undefined,
    nextTime: params.input.nextTime?.trim() || undefined,
    tags: normalizeTags(params.input.tags),
    related: params.input.related,
    meta: {
      cwd: (params.cwd ?? (() => process.cwd()))(),
      hostname: (params.hostname ?? (() => os.hostname()))(),
      platform: params.platform ?? process.platform,
      openclawVersion: params.openclawVersion,
    },
  };

  const filePath = resolveReflectionsPath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf-8" });
  return entry;
}

function safeParseLine(value: string): ReflectionEntry | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ReflectionEntry;
  } catch {
    return null;
  }
}

export async function readAllReflections(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReflectionEntry[]> {
  const filePath = resolveReflectionsPath(env);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const out: ReflectionEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parsed = safeParseLine(line);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
}

export type ReflectionListOptions = {
  limit?: number;
  tag?: string;
};

export async function listReflections(
  opts: ReflectionListOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReflectionEntry[]> {
  const all = await readAllReflections(env);
  const tag = opts.tag?.trim().toLowerCase();
  const filtered = tag
    ? all.filter((r) => (r.tags ?? []).map((t) => t.toLowerCase()).includes(tag))
    : all;

  const sorted = filtered
    .slice()
    .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  if (opts.limit && opts.limit > 0) {
    return sorted.slice(0, opts.limit);
  }
  return sorted;
}

export async function getReflectionById(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReflectionEntry | null> {
  const trimmed = id.trim();
  if (!trimmed) {
    return null;
  }
  const all = await readAllReflections(env);
  return all.find((r) => r.id === trimmed) ?? null;
}
