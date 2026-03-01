import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentId, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
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

      const payload: MemoryStatusPayload = {
        agentId,
        status,
        embedding,
        healthy,
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

      // Text search fallback: if QMD/semantic search returned empty but documents
      // exist (e.g. embeddings not yet computed), fall back to simple text grep.
      if (results.length === 0 && (status.files ?? 0) > 0) {
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
};

/**
 * Simple text search fallback for when QMD/semantic search returns empty
 * (e.g. embeddings haven't been computed yet). Scans all memory files for
 * case-insensitive substring matches and returns results with snippets.
 */
async function textSearchFallback(
  workspaceDir: string,
  query: string,
  maxResults?: number,
): Promise<MemorySearchResult[]> {
  const results: MemorySearchResult[] = [];
  const queryLower = query.toLowerCase();
  const limit = maxResults ?? 20;

  try {
    const memFiles = await listMemoryFiles(workspaceDir);
    for (const absPath of memFiles) {
      if (results.length >= limit) {
        break;
      }
      try {
        const content = await fs.readFile(absPath, "utf-8");
        const lines = content.split("\n");
        const matchingLines = lines
          .map((line, i) => ({ line, lineNum: i + 1 }))
          .filter(({ line }) => line.toLowerCase().includes(queryLower));
        if (matchingLines.length > 0) {
          const relPath = path.relative(workspaceDir, absPath);
          results.push({
            path: relPath,
            startLine: matchingLines[0].lineNum,
            endLine: matchingLines[matchingLines.length - 1].lineNum,
            score: 1.0,
            snippet: matchingLines
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

  return results;
}
