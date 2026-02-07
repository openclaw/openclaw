import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { redactSensitiveText } from "../logging/redact.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { hashText } from "./internal.js";

const log = createSubsystemLogger("memory");

export type SessionFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  content: string;
};

export async function listSessionFilesForAgent(agentId: string): Promise<string[]> {
  const dir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export function sessionPathForFile(absPath: string): string {
  return path.join("sessions", path.basename(absPath)).replace(/\\/g, "/");
}

function normalizeSessionText(value: string): string {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Break long lines at sentence boundaries for better chunk coherence.
 * Lines shorter than maxLineLength are returned unchanged.
 */
function breakLongLines(text: string, maxLineLength: number): string {
  if (text.length <= maxLineLength) {
    return text;
  }
  const result: string[] = [];
  let remaining = text;
  while (remaining.length > maxLineLength) {
    const searchRange = remaining.slice(0, maxLineLength);
    let splitPos = -1;
    // Look for sentence-ending punctuation followed by a space (scan from end)
    for (let i = searchRange.length - 1; i >= Math.floor(maxLineLength / 2); i -= 1) {
      const ch = searchRange[i];
      if (
        (ch === "." || ch === "?" || ch === "!") &&
        i + 1 < searchRange.length &&
        searchRange[i + 1] === " "
      ) {
        splitPos = i + 1;
        break;
      }
    }
    if (splitPos === -1) {
      // No sentence boundary found; fall back to last space
      const lastSpace = searchRange.lastIndexOf(" ");
      splitPos = lastSpace > Math.floor(maxLineLength / 2) ? lastSpace : maxLineLength;
    }
    result.push(remaining.slice(0, splitPos).trim());
    remaining = remaining.slice(splitPos).trim();
  }
  if (remaining) {
    result.push(remaining);
  }
  return result.join("\n");
}

export function extractSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    const normalized = normalizeSessionText(content);
    return normalized ? normalized : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") {
      continue;
    }
    const normalized = normalizeSessionText(record.text);
    if (normalized) {
      parts.push(normalized);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.join(" ");
}

export async function buildSessionEntry(absPath: string): Promise<SessionFileEntry | null> {
  try {
    const stat = await fs.stat(absPath);
    const raw = await fs.readFile(absPath, "utf-8");
    const lines = raw.split("\n");
    const collected: string[] = [];
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        !record ||
        typeof record !== "object" ||
        (record as { type?: unknown }).type !== "message"
      ) {
        continue;
      }
      const message = (record as { message?: unknown }).message as
        | { role?: unknown; content?: unknown }
        | undefined;
      if (!message || typeof message.role !== "string") {
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const text = extractSessionText(message.content);
      if (!text) {
        continue;
      }
      const safe = redactSensitiveText(text, { mode: "tools" });
      const label = message.role === "user" ? "User" : "Assistant";
      // Break long messages at sentence boundaries for better chunk quality
      collected.push(`${label}: ${breakLongLines(safe, 1000)}`);
    }
    // Use paragraph separators between messages for natural chunk boundaries
    const content = collected.join("\n\n");
    return {
      path: sessionPathForFile(absPath),
      absPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: hashText(content),
      content,
    };
  } catch (err) {
    log.debug(`Failed reading session file ${absPath}: ${String(err)}`);
    return null;
  }
}
