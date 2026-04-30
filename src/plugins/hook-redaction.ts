/** Internal transcript redaction helpers used by message-end hook retries. */

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RedactionAuditEntry } from "./hook-decision-types.js";

export type RedactMessageFilter = {
  indices?: number[];
  runId?: string;
  match?: {
    role: "user" | "assistant" | "tool";
    contentSubstring?: string;
  };
};

export type RedactMessageAuditInput = {
  reason: string;
  category?: string;
  hookPoint: string;
  pluginId: string;
  timestamp: number;
};

type TranscriptEntry = {
  raw: string;
  parsed: Record<string, unknown>;
  index: number;
  message: Record<string, unknown>;
  role?: string;
  text: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractMessageText(value: Record<string, unknown>): string {
  if (typeof value.content === "string") {
    return value.content;
  }
  if (Array.isArray(value.content)) {
    return value.content
      .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
      .join("");
  }
  return typeof value.text === "string" ? value.text : "";
}

function parseTranscriptEntries(rawContent: string): TranscriptEntry[] {
  const lines = rawContent.split("\n").filter((line) => line.trim().length > 0);
  return lines.map((raw, index) => {
    let parsed: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(raw);
      parsed = isRecord(value) ? value : {};
    } catch {
      // Keep malformed lines in place unless removed by explicit index.
    }

    const message = isRecord(parsed.message) ? parsed.message : parsed;
    const role = typeof message.role === "string" ? message.role : undefined;
    return {
      raw,
      parsed,
      index,
      message,
      role,
      text: extractMessageText(message),
    };
  });
}

function shouldRemoveEntry(params: {
  entry: TranscriptEntry;
  filter: RedactMessageFilter;
  explicitIndices: Set<number>;
}): boolean {
  const { entry, filter, explicitIndices } = params;
  if (explicitIndices.has(entry.index)) {
    return true;
  }
  if (filter.runId && entry.parsed.runId === filter.runId) {
    return true;
  }
  if (!filter.match || entry.role !== filter.match.role) {
    return false;
  }
  return !filter.match.contentSubstring || entry.text.includes(filter.match.contentSubstring);
}

function buildExplicitIndexSet(indices: number[] | undefined, entryCount: number): Set<number> {
  const result = new Set<number>();
  for (const index of indices ?? []) {
    if (Number.isInteger(index) && index >= 0 && index < entryCount) {
      result.add(index);
    }
  }
  return result;
}

function splitRedactedEntries(
  entries: TranscriptEntry[],
  filter: RedactMessageFilter,
): { keptLines: string[]; removedLines: string[] } {
  const explicitIndices = buildExplicitIndexSet(filter.indices, entries.length);
  const keptLines: string[] = [];
  const removedLines: string[] = [];

  for (const entry of entries) {
    if (shouldRemoveEntry({ entry, filter, explicitIndices })) {
      removedLines.push(entry.raw);
    } else {
      keptLines.push(entry.raw);
    }
  }

  return { keptLines, removedLines };
}

async function rewriteTranscriptFile(sessionFile: string, keptLines: string[]): Promise<void> {
  const tempFile = `${sessionFile}.redact-tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  const newContent = keptLines.length > 0 ? `${keptLines.join("\n")}\n` : "";

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(tempFile, newContent, "utf-8");
      await rename(tempFile, sessionFile);
      return;
    } catch (err) {
      lastError = err;
      const delay = 100 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error(`redactMessages: failed to atomically rewrite ${sessionFile} after 3 attempts`, {
    cause: lastError,
  });
}

async function appendRedactionAudit(params: {
  sessionFile: string;
  audit: RedactMessageAuditInput;
  removedLines: string[];
}): Promise<void> {
  try {
    const contentHash = createHash("sha256").update(params.removedLines.join("\n")).digest("hex");
    const auditEntry: RedactionAuditEntry = {
      ts: params.audit.timestamp,
      hookPoint: params.audit.hookPoint,
      pluginId: params.audit.pluginId,
      reason: params.audit.reason,
      category: params.audit.category,
      contentHash: `sha256:${contentHash}`,
      messagesRemoved: params.removedLines.length,
    };

    const auditFile = join(dirname(params.sessionFile), "redaction-log.jsonl");
    await mkdir(dirname(auditFile), { recursive: true });
    await appendFile(auditFile, `${JSON.stringify(auditEntry)}\n`, "utf-8");
  } catch {
    // Audit is best-effort. Redaction already succeeded.
  }
}

async function redactParsedEntries(params: {
  sessionFile: string;
  entries: TranscriptEntry[];
  filter: RedactMessageFilter;
  audit: RedactMessageAuditInput;
}): Promise<number> {
  const { keptLines, removedLines } = splitRedactedEntries(params.entries, params.filter);
  if (removedLines.length === 0) {
    return 0;
  }

  await rewriteTranscriptFile(params.sessionFile, keptLines);
  await appendRedactionAudit({
    sessionFile: params.sessionFile,
    audit: params.audit,
    removedLines,
  });
  return removedLines.length;
}

async function readTranscriptEntries(sessionFile: string): Promise<TranscriptEntry[] | null> {
  try {
    return parseTranscriptEntries(await readFile(sessionFile, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function redactMessages(
  sessionFile: string,
  filter: RedactMessageFilter,
  audit: RedactMessageAuditInput,
): Promise<number> {
  const entries = await readTranscriptEntries(sessionFile);
  if (!entries) {
    return 0;
  }
  return redactParsedEntries({ sessionFile, entries, filter, audit });
}

export async function redactDuplicateUserMessage(
  sessionFile: string,
  promptText: string,
): Promise<number> {
  if (!promptText) {
    return 0;
  }

  const entries = await readTranscriptEntries(sessionFile);
  if (!entries) {
    return 0;
  }

  const matchingUserIndices = entries
    .filter(
      (entry) =>
        entry.role === "user" &&
        entry.text &&
        (entry.text === promptText ||
          entry.text.includes(promptText) ||
          promptText.includes(entry.text)),
    )
    .map((entry) => entry.index);

  if (matchingUserIndices.length < 2) {
    return 0;
  }

  return redactParsedEntries({
    sessionFile,
    entries,
    filter: { indices: [matchingUserIndices[matchingUserIndices.length - 1]] },
    audit: {
      reason: "Removed duplicate user prompt created by llm_message_end retry",
      hookPoint: "llm_message_end:retry:user_dedupe",
      pluginId: "core",
      timestamp: Date.now(),
      category: "retry_dedupe",
    },
  });
}
