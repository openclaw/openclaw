import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentId, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import { computeMemoryHealthScore, type MemoryHealthScore } from "../../memory/health-score.js";
import { getMemorySearchManager } from "../../memory/index.js";
import { listMemoryFiles } from "../../memory/internal.js";
import type { MemoryProviderStatus, MemorySearchResult } from "../../memory/types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatError } from "../server-utils.js";
import type { GatewayRequestHandlers } from "./types.js";

export type MemoryStatusPayload = {
  agentId: string;
  status: MemoryProviderStatus | null;
  embedding: { ok: boolean; error?: string };
  healthy: boolean;
  healthScore?: MemoryHealthScore;
};

export type MemorySearchPayload = {
  results: MemorySearchResult[];
  provider: string;
  backend: string;
  model?: string;
  files?: number;
  fallbackSearch?: boolean;
};

export type MemoryReindexPayload = {
  ok: boolean;
  error?: string;
};

export type MemoryActivityEntry = {
  timestamp: number;
  operation: "search" | "read" | "write" | "edit";
  toolName: string;
  filePath?: string;
  query?: string;
  snippet?: string;
  sessionFile: string;
};

export type MemoryActivityPayload = {
  entries: MemoryActivityEntry[];
  sessionsScanned: number;
};

export const memoryDashboardHandlers: GatewayRequestHandlers = {
  "memory.status": async ({ respond }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    // Use default (full) mode so QMD manager initializes properly and
    // readCounts() can access the index DB. The manager is cached, so
    // subsequent calls (e.g. memory.search) reuse the same instance.
    const { manager, error } = await getMemorySearchManager({
      cfg,
      agentId,
    });
    if (!manager) {
      const payload: MemoryStatusPayload = {
        agentId,
        status: null,
        embedding: { ok: false, error: error ?? "memory search unavailable" },
        healthy: false,
      };
      respond(true, payload, undefined);
      return;
    }

    try {
      const status = manager.status();
      let embedding = await manager.probeEmbeddingAvailability();
      if (!embedding.ok && !embedding.error) {
        embedding = { ok: false, error: "memory embeddings unavailable" };
      }

      // Backend-aware health: QMD only tracks documents (files === chunks),
      // builtin tracks both separately. Fallback degrades health to false.
      const hasContent =
        status.backend === "qmd"
          ? (status.files ?? 0) > 0
          : (status.files ?? 0) > 0 && (status.chunks ?? 0) > 0;
      const healthy = embedding.ok && hasContent && !status.fallback;

      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      let healthScore: MemoryHealthScore | undefined;
      try {
        healthScore = computeMemoryHealthScore({
          status,
          embeddingOk: embedding.ok,
          workspaceDir,
        });
      } catch {
        // Non-critical — omit health score on error
      }

      const payload: MemoryStatusPayload = {
        agentId,
        status,
        embedding,
        healthy,
        healthScore,
      };
      respond(true, payload, undefined);
    } catch (err) {
      const payload: MemoryStatusPayload = {
        agentId,
        status: null,
        embedding: {
          ok: false,
          error: `gateway memory probe failed: ${formatError(err)}`,
        },
        healthy: false,
      };
      respond(true, payload, undefined);
    }
    // Don't close — let the cache manage the manager lifecycle
  },

  "memory.search": async ({ params, respond }) => {
    const query = params.query as string | undefined;
    if (!query || typeof query !== "string" || !query.trim()) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "params.query is required and must be a non-empty string",
        ),
      );
      return;
    }

    const maxResults = typeof params.maxResults === "number" ? params.maxResults : undefined;
    const minScore = typeof params.minScore === "number" ? params.minScore : undefined;

    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const { manager, error } = await getMemorySearchManager({ cfg, agentId });
    if (!manager) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, error ?? "memory search unavailable"),
      );
      return;
    }

    try {
      let results = await manager.search(query.trim(), { maxResults, minScore });
      const status = manager.status();
      let fallbackSearch = false;

      // Text search fallback: if QMD/semantic search returned empty, fall back
      // to simple text grep over memory files on disk. This covers cases where
      // QMD hasn't indexed files yet, or BM25 doesn't match multi-word queries.
      if (results.length === 0) {
        const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
        const textResults = await textSearchFallback(workspaceDir, query.trim(), maxResults);
        if (textResults.length > 0) {
          results = textResults;
          fallbackSearch = true;
        }
      }

      const payload: MemorySearchPayload = {
        results,
        provider: status.provider,
        backend: status.backend,
        model: status.model,
        files: status.files,
        fallbackSearch,
      };
      respond(true, payload, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `memory search failed: ${formatError(err)}`),
      );
    }
  },

  "memory.reindex": async ({ respond }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const { manager, error } = await getMemorySearchManager({ cfg, agentId });
    if (!manager) {
      const payload: MemoryReindexPayload = {
        ok: false,
        error: error ?? "memory search unavailable",
      };
      respond(true, payload, undefined);
      return;
    }

    try {
      await manager.sync?.({ reason: "dashboard", force: true });
      const payload: MemoryReindexPayload = { ok: true };
      respond(true, payload, undefined);
    } catch (err) {
      const payload: MemoryReindexPayload = {
        ok: false,
        error: `reindex failed: ${formatError(err)}`,
      };
      respond(true, payload, undefined);
    } finally {
      await manager.close?.().catch(() => {});
    }
  },

  "memory.collection.remove": async ({ respond, params }) => {
    const name = (params as { name?: string })?.name?.trim();
    if (!name) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "name is required"));
      return;
    }
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const { manager, error } = await getMemorySearchManager({ cfg, agentId });
    if (!manager) {
      respond(true, { ok: false, error: error ?? "memory search unavailable" }, undefined);
      return;
    }
    try {
      // Remove via QMD CLI with correct env vars
      const { execSync } = await import("node:child_process");
      const qmdCmd = cfg.memory?.qmd?.command ?? "qmd";
      execSync(`${qmdCmd} collection remove ${JSON.stringify(name)}`, {
        env: { ...process.env },
        timeout: 30000,
        stdio: "pipe",
      });
      respond(true, { ok: true, removed: name }, undefined);
    } catch (err) {
      respond(true, { ok: false, error: `remove failed: ${formatError(err)}` }, undefined);
    } finally {
      await manager.close?.().catch(() => {});
    }
  },

  "memory.embed": async ({ respond }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const { manager, error } = await getMemorySearchManager({ cfg, agentId });
    if (!manager) {
      const payload: MemoryReindexPayload = {
        ok: false,
        error: error ?? "memory search unavailable",
      };
      respond(true, payload, undefined);
      return;
    }

    try {
      // Force sync with embed — bypasses interval check and backoff
      await manager.sync?.({ reason: "embed-dashboard", force: true });
      const payload: MemoryReindexPayload = { ok: true };
      respond(true, payload, undefined);
    } catch (err) {
      const payload: MemoryReindexPayload = {
        ok: false,
        error: `embed failed: ${formatError(err)}`,
      };
      respond(true, payload, undefined);
    } finally {
      await manager.close?.().catch(() => {});
    }
  },

  "memory.activity": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const agentId = resolveDefaultAgentId(cfg);
      const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
      const payload = await scanMemoryActivity(sessionsDir);
      respond(true, payload, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `memory activity scan failed: ${formatError(err)}`),
      );
    }
  },
};

/**
 * Simple text search fallback for when QMD/semantic search returns empty
 * (e.g. embeddings haven't been computed yet). Scans all memory files for
 * case-insensitive substring matches and returns results with snippets.
 */
/** Common stopwords to ignore in multi-word text search */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "will",
  "with",
]);

async function textSearchFallback(
  workspaceDir: string,
  query: string,
  maxResults?: number,
): Promise<MemorySearchResult[]> {
  const results: MemorySearchResult[] = [];
  const queryLower = query.toLowerCase();
  const limit = maxResults ?? 20;

  // Extract meaningful keywords (drop stopwords, require length >= 2)
  const keywords = queryLower.split(/\s+/).filter((w) => w.length >= 2 && !STOPWORDS.has(w));

  // If no keywords survive filtering, use original query words
  const searchTerms =
    keywords.length > 0 ? keywords : queryLower.split(/\s+/).filter((w) => w.length >= 1);

  try {
    const memFiles = await listMemoryFiles(workspaceDir);
    for (const absPath of memFiles) {
      if (results.length >= limit) {
        break;
      }
      try {
        const [content, stat] = await Promise.all([
          fs.readFile(absPath, "utf-8"),
          fs.stat(absPath),
        ]);
        const lines = content.split("\n");

        // Score each line by how many search terms it contains
        const scoredLines = lines
          .map((line, i) => {
            const lower = line.toLowerCase();
            const matchCount = searchTerms.filter((term) => lower.includes(term)).length;
            return { line, lineNum: i + 1, matchCount };
          })
          .filter(({ matchCount }) => matchCount > 0)
          .toSorted((a, b) => b.matchCount - a.matchCount);

        if (scoredLines.length > 0) {
          // Prefer lines matching ALL terms, then rank by match count
          const bestMatch = scoredLines[0];
          const score = bestMatch.matchCount / searchTerms.length;
          const relPath = path.relative(workspaceDir, absPath);
          results.push({
            path: relPath,
            startLine: bestMatch.lineNum,
            endLine: scoredLines[scoredLines.length - 1].lineNum,
            score,
            modifiedAt: stat.mtimeMs,
            snippet: scoredLines
              .slice(0, 3)
              .map((m) => m.line)
              .join("\n"),
            source: "memory",
          });
        }
      } catch {
        // Skip files that can't be read
      }
    }
  } catch {
    // listMemoryFiles may fail if workspace doesn't exist
  }

  // Sort by score descending so best matches come first
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Scans all session JSONL files in the sessions directory and extracts memory
 * tool calls directly from the raw transcript. This bypasses chat.history's
 * message count and byte-size limits to capture ALL memory activity.
 */
async function scanMemoryActivity(sessionsDir: string): Promise<MemoryActivityPayload> {
  const entries: MemoryActivityEntry[] = [];
  let sessionsScanned = 0;

  let files: string[];
  try {
    files = (await fs.readdir(sessionsDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return { entries, sessionsScanned: 0 };
  }

  for (const file of files) {
    sessionsScanned++;
    try {
      const content = fsSync.readFileSync(path.join(sessionsDir, file), "utf-8");
      const lines = content.split(/\r?\n/);

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const parsed = JSON.parse(line);
          if (parsed?.type !== "message") {
            continue;
          }
          const msg = parsed.message;
          if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) {
            continue;
          }

          const timestamp =
            typeof parsed.timestamp === "string"
              ? new Date(parsed.timestamp).getTime()
              : typeof msg.timestamp === "number"
                ? msg.timestamp
                : 0;

          for (const block of msg.content) {
            if (block.type !== "toolCall" && block.type !== "tool_use") {
              continue;
            }

            const toolName = (block.name ?? "") as string;
            const toolInput = (block.arguments ?? block.input) as
              | Record<string, unknown>
              | undefined;

            if (!isMemoryActivityToolCall(toolName, toolInput)) {
              continue;
            }

            entries.push({
              timestamp,
              operation: getActivityOperation(toolName, toolInput),
              toolName,
              filePath: getActivityFilePath(toolName, toolInput),
              query: toolInput?.query as string | undefined,
              snippet: getActivitySnippet(toolName, toolInput),
              sessionFile: file,
            });
          }
        } catch {
          // Skip unparseable lines
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  entries.sort((a, b) => b.timestamp - a.timestamp);
  return { entries, sessionsScanned };
}

function isMemoryActivityToolCall(toolName: string, toolInput?: Record<string, unknown>): boolean {
  if (toolName === "memory_search" || toolName === "memory_get" || toolName === "memory_read") {
    return true;
  }
  const filePath = (toolInput?.path ?? toolInput?.file_path ?? toolInput?.relPath) as
    | string
    | undefined;
  if (!filePath) {
    return false;
  }
  const lower = filePath.toLowerCase();
  if (toolName === "write" || toolName === "edit" || toolName === "read") {
    return lower.includes("memory") || lower.includes("/workspace/");
  }
  return false;
}

function getActivityOperation(
  toolName: string,
  toolInput?: Record<string, unknown>,
): MemoryActivityEntry["operation"] {
  if (toolName === "memory_search") {
    return "search";
  }
  if (toolName === "memory_get" || toolName === "memory_read" || toolName === "read") {
    return "read";
  }
  if (toolName === "write") {
    return "write";
  }
  if (toolName === "edit") {
    return "edit";
  }
  if (toolInput?.content !== undefined) {
    return "write";
  }
  return "read";
}

function getActivityFilePath(
  toolName: string,
  toolInput?: Record<string, unknown>,
): string | undefined {
  if (toolName === "memory_search") {
    return undefined;
  }
  return (toolInput?.path ?? toolInput?.file_path ?? toolInput?.relPath) as string | undefined;
}

function getActivitySnippet(
  toolName: string,
  toolInput?: Record<string, unknown>,
): string | undefined {
  if (!toolInput) {
    return undefined;
  }
  if (toolName === "memory_search" && toolInput.query) {
    const q =
      typeof toolInput.query === "string" ? toolInput.query : JSON.stringify(toolInput.query);
    return q.length > 120 ? q.slice(0, 120) + "..." : q;
  }
  const content = (toolInput.content ?? toolInput.new_string ?? toolInput.newText) as
    | string
    | undefined;
  if (content) {
    return content.length > 120 ? content.slice(0, 120) + "..." : content;
  }
  const filePath = (toolInput.path ?? toolInput.file_path) as string | undefined;
  if (filePath) {
    return filePath;
  }
  return undefined;
}
