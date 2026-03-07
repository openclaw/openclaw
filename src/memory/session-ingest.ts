import fs from "node:fs";
import path from "node:path";
import {
  resolveDefaultMemorySearchModel,
  resolveMemorySearchConfig,
} from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { extractEntities } from "./entity-extract.js";
import { hashText } from "./internal.js";
import { ensureMemoryIndexSchema } from "./memory-schema.js";
import { requireNodeSqlite } from "./sqlite.js";

type SessionTextEntry = {
  role: string;
  text: string;
  index: number;
};

const SESSION_MODEL_FALLBACK = "fts-only";
const SESSION_SOURCE = "sessions";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const FTS_TABLE = "chunks_fts";

export function extractSessionText(messages: unknown[]): SessionTextEntry[] {
  const result: SessionTextEntry[] = [];
  if (!Array.isArray(messages)) {
    return result;
  }

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || typeof message !== "object") {
      continue;
    }

    const role = normalizeRole((message as { role?: unknown }).role);
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const text = extractMessageText((message as { content?: unknown }).content, role);
    if (!text) {
      continue;
    }

    result.push({ role, text, index: i });
  }

  return result;
}

export async function ingestSessionToMemory(params: {
  messages: unknown[];
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  config?: OpenClawConfig;
  agentId?: string;
  maxChunks?: number;
}): Promise<{ chunksWritten: number; error?: string }> {
  try {
    // B10: Only ingest for builtin backend
    if (params.config) {
      const backendCfg = params.config.agents?.defaults?.memorySearch ?? {};
      const backend = (backendCfg as Record<string, unknown>).backend;
      if (backend && backend !== "builtin") {
        return { chunksWritten: 0 };
      }
    }

    const texts = extractSessionText(params.messages);
    if (texts.length === 0) {
      return { chunksWritten: 0 };
    }

    const dbPath = resolveMemoryDbPath(params);
    if (!dbPath) {
      return { chunksWritten: 0 };
    }

    // B7: Respect sessions source opt-out
    if (params.config) {
      const agentId = params.agentId?.trim() || params.sessionKey?.split(":")[0]?.trim() || "main";
      const cfg = resolveMemorySearchConfig(params.config, agentId);
      const sources = cfg?.sources ?? ["memory"];
      if (!sources.includes("sessions")) {
        return { chunksWritten: 0 };
      }
    }

    // B9: Create memory DB directory if it does not exist yet
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const joinedText = texts
      .map((entry) => `${entry.role === "assistant" ? "Assistant" : "User"}: ${entry.text}`)
      .join("\n\n");
    const rawChunks = chunkText(joinedText, 2000, 300);
    const maxChunks = Math.max(1, params.maxChunks ?? 50);
    const chunks = rawChunks.slice(0, maxChunks);
    if (chunks.length === 0) {
      return { chunksWritten: 0 };
    }

    // B2: Resolve embedding model from config to match hybrid search filter
    let sessionModel = SESSION_MODEL_FALLBACK;
    if (params.config) {
      const resolvedAgentId =
        params.agentId?.trim() || params.sessionKey?.split(":")[0]?.trim() || "main";
      const memCfg = resolveMemorySearchConfig(params.config, resolvedAgentId);
      const configuredModel = memCfg?.model || resolveDefaultMemorySearchModel(memCfg?.provider);
      if (configuredModel) {
        sessionModel = configuredModel;
      }
    }

    const sessionPath = `session/${params.sessionKey ?? params.sessionId ?? "unknown"}`;
    const sourceDate = new Date().toISOString().slice(0, 10);
    const now = Date.now();

    const sqlite = requireNodeSqlite();
    const db = new sqlite.DatabaseSync(dbPath);
    try {
      ensureMemoryIndexSchema({
        db,
        embeddingCacheTable: EMBEDDING_CACHE_TABLE,
        ftsTable: FTS_TABLE,
        ftsEnabled: true,
      });

      db.exec("BEGIN");
      try {
        db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(
          sessionPath,
          SESSION_SOURCE,
        );
        try {
          db.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ?`).run(
            sessionPath,
            SESSION_SOURCE,
          );
        } catch {}

        const insertChunk = db.prepare(
          `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, source_date, entities)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             hash=excluded.hash,
             model=excluded.model,
             text=excluded.text,
             embedding=excluded.embedding,
             updated_at=excluded.updated_at,
             source_date=excluded.source_date,
             entities=excluded.entities`,
        );

        let insertFts: ReturnType<typeof db.prepare> | undefined;
        try {
          insertFts = db.prepare(
            `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          );
        } catch {}

        let written = 0;
        for (let i = 0; i < chunks.length; i += 1) {
          const chunk = chunks[i];
          const chunkHash = hashText(chunk);
          const id = hashText(`session:${sessionPath}:${i}:${chunkHash}`);
          const entities = extractEntities(chunk);
          const entitiesJson = entities.length > 0 ? JSON.stringify(entities) : null;
          const startLine = i * 10 + 1;
          const endLine = startLine + 9;

          insertChunk.run(
            id,
            sessionPath,
            SESSION_SOURCE,
            startLine,
            endLine,
            chunkHash,
            sessionModel,
            chunk,
            "[]",
            now,
            sourceDate,
            entitiesJson,
          );

          if (insertFts) {
            insertFts.run(chunk, id, sessionPath, SESSION_SOURCE, sessionModel, startLine, endLine);
          }

          written += 1;
        }

        db.exec("COMMIT");
        return { chunksWritten: written };
      } catch (err) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw err;
      }
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      chunksWritten: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function resolveMemoryDbPath(params: {
  workspaceDir?: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  const agentId = params.agentId?.trim() || params.sessionKey?.split(":")[0]?.trim() || "main";

  if (params.config) {
    const cfg = resolveMemorySearchConfig(params.config, agentId);
    if (!cfg?.enabled) {
      return undefined;
    }
    return cfg.store.path;
  }

  if (!params.workspaceDir) {
    return undefined;
  }
  return path.join(params.workspaceDir, ".memory", "index.sqlite");
}

function normalizeRole(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function extractMessageText(content: unknown, role: "user" | "assistant"): string {
  if (typeof content === "string") {
    return sanitizeText(content, role);
  }

  if (!Array.isArray(content)) {
    return "";
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
    const cleaned = sanitizeText(record.text, role);
    if (!cleaned) {
      continue;
    }
    parts.push(cleaned);
  }

  return parts.join("\n").trim();
}

function sanitizeText(text: string, role: "user" | "assistant"): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  if (looksLikeBase64Data(trimmed)) {
    return "";
  }

  if (role === "assistant" && looksLikeToolCallText(trimmed)) {
    return "";
  }

  return redactSensitiveText(trimmed);
}

/**
 * B3: Redact sensitive patterns (API keys, tokens, passwords) before storage.
 */
function redactSensitiveText(text: string): string {
  return text
    .replace(/\b(sk-[a-zA-Z0-9]{20,})/g, "[REDACTED]")
    .replace(/\b(xox[bprs]-[a-zA-Z0-9-]{20,})/g, "[REDACTED]")
    .replace(/\b(ghp_[a-zA-Z0-9]{36,})/g, "[REDACTED]")
    .replace(/\b(gho_[a-zA-Z0-9]{36,})/g, "[REDACTED]")
    .replace(/\b(AKIA[0-9A-Z]{16})/g, "[REDACTED]")
    .replace(/(Bearer\s+)[a-zA-Z0-9._-]{20,}/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|secret|token|password|passwd|credentials)\s*[=:]\s*)[^\s"']{8,}/gi,
      "$1[REDACTED]",
    );
}

function looksLikeBase64Data(text: string): boolean {
  if (text.startsWith("data:image/")) {
    return true;
  }
  if (text.length < 512) {
    return false;
  }
  return /^[A-Za-z0-9+/=\s]+$/.test(text);
}

function looksLikeToolCallText(text: string): boolean {
  if (/^<\/?tool_?use\b/i.test(text)) {
    return true;
  }
  if (/^```(?:json)?\s*\{[\s\S]*"(?:tool|function|tool_name|tool_call)"\s*:/i.test(text)) {
    return true;
  }
  if (/^\{[\s\S]*"type"\s*:\s*"tool_?use"/i.test(text)) {
    return true;
  }
  return false;
}

function chunkText(text: string, maxChars: number, overlapChars: number): string[] {
  const paragraphs = text
    .split(/\n\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (paragraphs.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  let current: string[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    chunks.push(current.join("\n\n"));

    if (overlapChars <= 0) {
      current = [];
      currentChars = 0;
      return;
    }

    let carryChars = 0;
    const carry: string[] = [];
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const paragraph = current[i];
      if (!paragraph) {
        continue;
      }
      carry.unshift(paragraph);
      carryChars += paragraph.length + (carry.length > 1 ? 2 : 0);
      if (carryChars >= overlapChars) {
        break;
      }
    }

    current = carry;
    currentChars = carryChars;
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current.length > 0) {
        flush();
      }
      for (let start = 0; start < paragraph.length; start += maxChars) {
        const segment = paragraph.slice(start, start + maxChars).trim();
        if (segment) {
          chunks.push(segment);
        }
      }
      current = [];
      currentChars = 0;
      continue;
    }

    const nextChars = currentChars + (current.length > 0 ? 2 : 0) + paragraph.length;
    if (nextChars > maxChars && current.length > 0) {
      flush();
    }

    current.push(paragraph);
    currentChars += (current.length > 1 ? 2 : 0) + paragraph.length;
  }

  if (current.length > 0) {
    chunks.push(current.join("\n\n"));
  }

  return chunks;
}
