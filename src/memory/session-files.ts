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

type ArtifactRef = {
  id: string;
  summary?: string;
  toolName?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function extractArtifactRef(details: unknown): ArtifactRef | null {
  if (!isRecord(details)) {
    return null;
  }
  const ref = details.artifactRef;
  if (!isRecord(ref)) {
    return null;
  }
  if (typeof ref.id !== "string" || ref.id.length === 0) {
    return null;
  }
  return {
    id: ref.id,
    summary: typeof ref.summary === "string" ? ref.summary : undefined,
    toolName: typeof ref.toolName === "string" ? ref.toolName : undefined,
  };
}

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
      if (message.role === "user" || message.role === "assistant") {
        const text = extractSessionText(message.content);
        if (!text) {
          continue;
        }
        const safe = redactSensitiveText(text, { mode: "tools" });
        const label = message.role === "user" ? "User" : "Assistant";
        collected.push(`${label}: ${safe}`);
        continue;
      }
      if (message.role === "toolResult") {
        const ref = extractArtifactRef((message as { details?: unknown }).details);
        if (!ref) {
          continue;
        }
        const summary = ref.summary?.trim() ? ref.summary.trim() : "artifact";
        const safe = redactSensitiveText(summary, { mode: "tools" });
        const toolName =
          ref.toolName?.trim() || (message as { toolName?: string }).toolName?.trim();
        const label = toolName ? `ToolResult (${toolName})` : "ToolResult";
        collected.push(`${label}: ${safe} [artifact:${ref.id}]`);
      }
    }
    const content = collected.join("\n");
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
