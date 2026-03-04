import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type {
  SessionMemoryAuditEntry,
  SessionMemoryRawEntry,
  SessionMemorySummaryEntry,
} from "./types.js";
import {
  sessionMemoryAuditEntrySchema,
  sessionMemoryRawEntrySchema,
  sessionMemorySummaryEntrySchema,
} from "./types.js";

function encodeMessageId(messageId: string): string {
  const normalized = messageId.trim();
  const safe = normalized.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${safe || "message"}-${digest}`;
}

export function resolveSessionMemoryBaseDir(agentId: string): string {
  return path.join(resolveStateDir(process.env), "agents", normalizeAgentId(agentId), "session-memory");
}

export function resolveSessionMemoryRawDir(agentId: string, sessionId: string): string {
  return path.join(resolveSessionMemoryBaseDir(agentId), "raw", sessionId);
}

export function resolveSessionMemorySummaryFile(agentId: string, sessionId: string): string {
  return path.join(resolveSessionMemoryBaseDir(agentId), "summary", `${sessionId}.jsonl`);
}

export function resolveSessionMemoryAuditFile(agentId: string, sessionId: string): string {
  return path.join(resolveSessionMemoryBaseDir(agentId), "audit", `${sessionId}.jsonl`);
}

export function resolveSessionMemoryRawFile(params: {
  agentId: string;
  sessionId: string;
  messageId: string;
}): string {
  return path.join(
    resolveSessionMemoryRawDir(params.agentId, params.sessionId),
    `${encodeMessageId(params.messageId)}.json`,
  );
}

async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function appendJsonLine(filePath: string, payload: unknown): Promise<void> {
  await ensureParentDir(filePath);
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

async function safeReadUtf8(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

export async function writeSessionMemoryRawEntry(params: {
  agentId: string;
  sessionId: string;
  entry: SessionMemoryRawEntry;
}): Promise<string> {
  const parsed = sessionMemoryRawEntrySchema.parse(params.entry);
  const filePath = resolveSessionMemoryRawFile({
    agentId: params.agentId,
    sessionId: params.sessionId,
    messageId: parsed.messageId,
  });
  await ensureParentDir(filePath);
  await fs.writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return filePath;
}

export async function readSessionMemoryRawEntry(filePath: string): Promise<SessionMemoryRawEntry | null> {
  const raw = await safeReadUtf8(filePath);
  if (!raw) {
    return null;
  }
  try {
    return sessionMemoryRawEntrySchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function readSessionMemoryRawEntries(params: {
  agentId: string;
  sessionId: string;
}): Promise<Array<{ filePath: string; entry: SessionMemoryRawEntry }>> {
  const dir = resolveSessionMemoryRawDir(params.agentId, params.sessionId);
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const rows = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        const filePath = path.join(dir, name);
        const entry = await readSessionMemoryRawEntry(filePath);
        return entry ? { filePath, entry } : null;
      }),
  );
  return rows.filter((row): row is { filePath: string; entry: SessionMemoryRawEntry } => Boolean(row));
}

function parseJsonLines<T>(raw: string, parse: (value: unknown) => T): T[] {
  const results: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      results.push(parse(JSON.parse(trimmed)));
    } catch {
      continue;
    }
  }
  return results;
}

export async function readSessionMemorySummaryEntries(params: {
  agentId: string;
  sessionId: string;
}): Promise<SessionMemorySummaryEntry[]> {
  const filePath = resolveSessionMemorySummaryFile(params.agentId, params.sessionId);
  const raw = await safeReadUtf8(filePath);
  if (!raw) {
    return [];
  }
  return parseJsonLines(raw, (value) => sessionMemorySummaryEntrySchema.parse(value));
}

export async function appendSessionMemorySummaryEntry(params: {
  agentId: string;
  sessionId: string;
  entry: SessionMemorySummaryEntry;
}): Promise<void> {
  await appendJsonLine(
    resolveSessionMemorySummaryFile(params.agentId, params.sessionId),
    sessionMemorySummaryEntrySchema.parse(params.entry),
  );
}

export async function readSessionMemoryAuditEntries(params: {
  agentId: string;
  sessionId: string;
}): Promise<SessionMemoryAuditEntry[]> {
  const filePath = resolveSessionMemoryAuditFile(params.agentId, params.sessionId);
  const raw = await safeReadUtf8(filePath);
  if (!raw) {
    return [];
  }
  return parseJsonLines(raw, (value) => sessionMemoryAuditEntrySchema.parse(value));
}

export async function appendSessionMemoryAuditEntry(params: {
  agentId: string;
  sessionId: string;
  entry: SessionMemoryAuditEntry;
}): Promise<void> {
  await appendJsonLine(
    resolveSessionMemoryAuditFile(params.agentId, params.sessionId),
    sessionMemoryAuditEntrySchema.parse(params.entry),
  );
}

export async function sweepExpiredSessionMemoryRawEntries(params: {
  agentId: string;
  sessionId: string;
  now: number;
}): Promise<SessionMemoryRawEntry[]> {
  const rawEntries = await readSessionMemoryRawEntries(params);
  const expired = rawEntries.filter(({ entry }) => {
    const expiresAt = Date.parse(entry.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt <= params.now;
  });
  await Promise.all(expired.map(({ filePath }) => fs.rm(filePath, { force: true })));
  return expired.map(({ entry }) => entry);
}

export async function deleteSessionMemoryArtifacts(params: {
  agentId: string;
  sessionId: string | undefined;
}): Promise<void> {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    return;
  }
  await Promise.all([
    fs.rm(resolveSessionMemoryRawDir(params.agentId, sessionId), {
      recursive: true,
      force: true,
    }),
    fs.rm(resolveSessionMemorySummaryFile(params.agentId, sessionId), {
      force: true,
    }),
    fs.rm(resolveSessionMemoryAuditFile(params.agentId, sessionId), {
      force: true,
    }),
  ]);
}
