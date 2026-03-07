import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type {
  SessionMemoryAuditEntry,
  SessionMemoryMcpRawEntry,
  SessionMemoryRawEntry,
  SessionMemorySummaryEntry,
} from "./types.js";
import {
  sessionMemoryAuditEntrySchema,
  sessionMemoryMcpRawEntrySchema,
  sessionMemoryRawEntrySchema,
  sessionMemorySummaryEntrySchema,
} from "./types.js";

const summaryWriteChains = new Map<string, Promise<void>>();

async function withSummaryWriteLock<T>(filePath: string, op: () => Promise<T>): Promise<T> {
  const previous = summaryWriteChains.get(filePath) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const nextChain = previous.then(() => current);
  summaryWriteChains.set(filePath, nextChain);

  await previous;
  try {
    return await op();
  } finally {
    releaseCurrent?.();
    if (summaryWriteChains.get(filePath) === nextChain) {
      summaryWriteChains.delete(filePath);
    }
  }
}

function encodeMessageId(messageId: string): string {
  const normalized = messageId.trim();
  const safe = normalized.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${safe || "message"}-${digest}`;
}

export function resolveSessionMemoryBaseDir(agentId: string): string {
  return path.join(
    resolveStateDir(process.env),
    "agents",
    normalizeAgentId(agentId),
    "session-memory",
  );
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

export async function deleteSessionMemoryRawEntry(params: {
  agentId: string;
  sessionId: string;
  entry: Pick<SessionMemoryRawEntry, "messageId">;
}): Promise<void> {
  const filePath = resolveSessionMemoryRawFile({
    agentId: params.agentId,
    sessionId: params.sessionId,
    messageId: params.entry.messageId,
  });
  await fs.rm(filePath, { force: true });
}

export async function readSessionMemoryRawEntry(
  filePath: string,
): Promise<SessionMemoryRawEntry | null> {
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
  return rows.filter((row): row is { filePath: string; entry: SessionMemoryRawEntry } =>
    Boolean(row),
  );
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
  const filePath = resolveSessionMemorySummaryFile(params.agentId, params.sessionId);
  const parsed = sessionMemorySummaryEntrySchema.parse(params.entry);
  await withSummaryWriteLock(filePath, async () => {
    await appendJsonLine(filePath, parsed);
  });
}

/**
 * Upsert a summary entry by messageId.
 *
 * If an entry with the same messageId already exists in the summary file, it is
 * replaced in-place. If no entry matches, the new entry is appended. This makes
 * summary writes idempotent per messageId, matching the raw mirror which is
 * already keyed by messageId filename.
 */
export async function upsertSessionMemorySummaryEntry(params: {
  agentId: string;
  sessionId: string;
  entry: SessionMemorySummaryEntry;
}): Promise<void> {
  const parsed = sessionMemorySummaryEntrySchema.parse(params.entry);
  const filePath = resolveSessionMemorySummaryFile(params.agentId, params.sessionId);
  await withSummaryWriteLock(filePath, async () => {
    const existing = await readSessionMemorySummaryEntries({
      agentId: params.agentId,
      sessionId: params.sessionId,
    });
    const idx = existing.findIndex((e) => e.messageId === parsed.messageId);
    if (idx === -1) {
      // No existing entry - append as normal.
      await appendJsonLine(filePath, parsed);
      return;
    }
    // Replace the existing entry and rewrite the whole file.
    existing[idx] = parsed;
    await ensureParentDir(filePath);
    await fs.writeFile(filePath, existing.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  });
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

function encodeMcpToolCallId(toolCallId: string): string {
  const normalized = toolCallId.trim();
  const safe = normalized.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  const digest = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `mcp-${safe || "tool"}-${digest}`;
}

export function resolveSessionMemoryMcpRawFile(params: {
  agentId: string;
  sessionId: string;
  toolCallId: string;
}): string {
  return path.join(
    resolveSessionMemoryRawDir(params.agentId, params.sessionId),
    `${encodeMcpToolCallId(params.toolCallId)}.json`,
  );
}

export async function writeSessionMemoryMcpRawEntry(params: {
  agentId: string;
  sessionId: string;
  entry: SessionMemoryMcpRawEntry;
}): Promise<string> {
  const parsed = sessionMemoryMcpRawEntrySchema.parse(params.entry);
  const filePath = resolveSessionMemoryMcpRawFile({
    agentId: params.agentId,
    sessionId: params.sessionId,
    toolCallId: parsed.toolCallId,
  });
  await ensureParentDir(filePath);
  await fs.writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return filePath;
}

export async function readSessionMemoryMcpRawEntry(
  filePath: string,
): Promise<SessionMemoryMcpRawEntry | null> {
  const raw = await safeReadUtf8(filePath);
  if (!raw) {
    return null;
  }
  try {
    return sessionMemoryMcpRawEntrySchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function readSessionMemoryMcpRawEntries(params: {
  agentId: string;
  sessionId: string;
}): Promise<Array<{ filePath: string; entry: SessionMemoryMcpRawEntry }>> {
  const dir = resolveSessionMemoryRawDir(params.agentId, params.sessionId);
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const rows = await Promise.all(
    names
      .filter((name) => name.startsWith("mcp-") && name.endsWith(".json"))
      .map(async (name) => {
        const filePath = path.join(dir, name);
        const entry = await readSessionMemoryMcpRawEntry(filePath);
        return entry ? { filePath, entry } : null;
      }),
  );
  return rows.filter((row): row is { filePath: string; entry: SessionMemoryMcpRawEntry } =>
    Boolean(row),
  );
}

export async function sweepExpiredSessionMemoryMcpRawEntries(params: {
  agentId: string;
  sessionId: string;
  now: number;
}): Promise<SessionMemoryMcpRawEntry[]> {
  const mcpEntries = await readSessionMemoryMcpRawEntries(params);
  const expired = mcpEntries.filter(({ entry }) => {
    const expiresAt = Date.parse(entry.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt <= params.now;
  });
  await Promise.all(expired.map(({ filePath }) => fs.rm(filePath, { force: true })));
  return expired.map(({ entry }) => entry);
}

/**
 * Remove audit entries older than `retentionDays` days from the audit log.
 * Rewrites the file in-place. No-ops if the file doesn't exist or is empty.
 * Deletes the file entirely if all entries are older than the retention window.
 */
export async function sweepOldAuditEntries(params: {
  agentId: string;
  sessionId: string;
  retentionDays: number;
}): Promise<void> {
  const filePath = resolveSessionMemoryAuditFile(params.agentId, params.sessionId);
  const raw = await safeReadUtf8(filePath);
  if (!raw) return;
  const entries = parseJsonLines(raw, (value) => sessionMemoryAuditEntrySchema.parse(value));
  const cutoffMs = Date.now() - params.retentionDays * 24 * 60 * 60 * 1000;
  const kept = entries.filter((e) => {
    const ts = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
    return !Number.isFinite(ts) || ts >= cutoffMs;
  });
  if (kept.length === entries.length) return; // nothing to sweep
  if (kept.length === 0) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await ensureParentDir(filePath);
  await fs.writeFile(filePath, kept.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
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

