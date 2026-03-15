/**
 * Graph memory backend — searches a SQLite knowledge graph created by the memory-graph skill.
 * Uses FTS5 for full-text search with tier-based score boosting and auto-reinforcement.
 */

import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { requireNodeSqlite } from "./sqlite.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
} from "./types.js";

const log = createSubsystemLogger("memory");

const DEFAULT_DB_PATH = "memory/graph/tommy_memory.db";
const NODE_ID_PATTERN = /^[A-Z]\d{1,4}$/;
const SNIPPET_MAX_CHARS = 700;

export type GraphManagerConfig = {
  dbPath: string;
  fts: boolean;
  anchorBoost: number;
  transitionBoost: number;
  autoReinforce: boolean;
};

export function resolveGraphConfig(params: {
  workspaceDir: string;
  raw?: {
    dbPath?: string;
    fts?: boolean;
    anchorBoost?: number;
    transitionBoost?: number;
    autoReinforce?: boolean;
  };
}): GraphManagerConfig {
  const raw = params.raw ?? {};
  const dbPathRaw = raw.dbPath?.trim() || DEFAULT_DB_PATH;
  const dbPath = path.isAbsolute(dbPathRaw)
    ? dbPathRaw
    : path.resolve(params.workspaceDir, dbPathRaw);

  return {
    dbPath,
    fts: raw.fts !== false,
    anchorBoost: raw.anchorBoost ?? 1.5,
    transitionBoost: raw.transitionBoost ?? 1.2,
    autoReinforce: raw.autoReinforce !== false,
  };
}

export class GraphMemoryManager implements MemorySearchManager {
  private db: DatabaseSync;
  private readonly config: GraphManagerConfig;
  private searchStmt: StatementSync | null = null;
  private nodeStmt: StatementSync | null = null;
  private edgesStmt: StatementSync | null = null;
  private reinforceStmt: StatementSync | null = null;
  private nodeCount: number;

  private constructor(db: DatabaseSync, config: GraphManagerConfig, nodeCount: number) {
    this.db = db;
    this.config = config;
    this.nodeCount = nodeCount;
  }

  static create(config: GraphManagerConfig): GraphMemoryManager | null {
    const { DatabaseSync: DBSync } = requireNodeSqlite();
    let db: DatabaseSync;
    try {
      db = new DBSync(config.dbPath, { open: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`graph memory: failed to open db at ${config.dbPath}: ${message}`);
      return null;
    }

    // Verify schema
    try {
      const row = db.prepare("SELECT COUNT(*) AS cnt FROM nodes").get() as { cnt: number };
      return new GraphMemoryManager(db, config, row.cnt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`graph memory: db missing expected schema: ${message}`);
      try {
        db.close();
      } catch {
        // ignore
      }
      return null;
    }
  }

  /** For testing with an externally-provided in-memory DB */
  static createFromDb(db: DatabaseSync, config: GraphManagerConfig): GraphMemoryManager {
    const row = db.prepare("SELECT COUNT(*) AS cnt FROM nodes").get() as { cnt: number };
    return new GraphMemoryManager(db, config, row.cnt);
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number },
  ): Promise<MemorySearchResult[]> {
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }
    const maxResults = opts?.maxResults ?? 6;
    const minScore = opts?.minScore ?? 0;

    if (!this.config.fts) {
      return [];
    }

    const ftsQuery = this.buildFtsQuery(cleaned);
    if (!ftsQuery) {
      return [];
    }

    if (!this.searchStmt) {
      this.searchStmt = this.db.prepare(
        `SELECT n.id, n.title, n.narrative, n.tier, n.weight, n.reinforcement,
                bm25(nodes_fts) AS rank
         FROM nodes_fts f
         JOIN nodes n ON n.id = f.id
         WHERE nodes_fts MATCH ?
         ORDER BY rank ASC
         LIMIT ?`,
      );
    }

    type FtsRow = {
      id: string;
      title: string;
      narrative: string;
      tier: string;
      weight: number;
      reinforcement: number;
      rank: number;
    };

    const rows = this.searchStmt.all(ftsQuery, maxResults * 3) as FtsRow[];

    const results: MemorySearchResult[] = rows.map((row) => {
      const bm25Score = 1 / (1 + Math.max(0, row.rank));
      const tierBoost = this.tierBoost(row.tier);
      const weightFactor = row.weight / 10;
      const score = bm25Score * tierBoost * weightFactor;
      const snippet =
        row.narrative.length > SNIPPET_MAX_CHARS
          ? row.narrative.slice(0, SNIPPET_MAX_CHARS) + "…"
          : row.narrative;

      return {
        path: row.id,
        startLine: 1,
        endLine: 1,
        score,
        snippet: `[${row.id}] ${row.title}\n\n${snippet}`,
        source: "memory" as const,
        citation: `graph:${row.id}`,
      };
    });

    // Re-sort by computed score and apply limit/threshold
    results.sort((a, b) => b.score - a.score);
    const filtered = results.filter((r) => r.score >= minScore).slice(0, maxResults);

    // Auto-reinforce
    if (this.config.autoReinforce && filtered.length > 0) {
      this.reinforceNodes(filtered.map((r) => r.path));
    }

    return filtered;
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const id = params.relPath.trim().toUpperCase();
    if (NODE_ID_PATTERN.test(id)) {
      return this.readNode(id);
    }
    // Not a node ID — return empty; the fallback wrapper will try builtin
    return { text: "", path: params.relPath };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "graph" as const,
      provider: "sqlite-fts5",
      model: undefined,
      files: this.nodeCount,
      chunks: this.nodeCount,
      dbPath: this.config.dbPath,
      fts: { enabled: this.config.fts, available: this.config.fts },
      vector: { enabled: false, available: false },
      custom: {
        graphBackend: true,
        anchorBoost: this.config.anchorBoost,
        transitionBoost: this.config.transitionBoost,
        autoReinforce: this.config.autoReinforce,
      },
    };
  }

  async sync(): Promise<void> {
    // Graph is written to externally by memgraph CLI. No sync needed.
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return { ok: true };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return false;
  }

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }

  // --- Private ---

  private tierBoost(tier: string): number {
    switch (tier) {
      case "anchor":
        return this.config.anchorBoost;
      case "transition":
        return this.config.transitionBoost;
      default:
        return 1.0;
    }
  }

  private buildFtsQuery(raw: string): string | null {
    const tokens =
      raw
        .match(/[\p{L}\p{N}_]+/gu)
        ?.map((t) => t.trim())
        .filter(Boolean) ?? [];
    if (tokens.length === 0) {
      return null;
    }
    // Use OR for recall breadth (graph nodes are already curated/small)
    return tokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" OR ");
  }

  private readNode(id: string): { text: string; path: string } {
    if (!this.nodeStmt) {
      this.nodeStmt = this.db.prepare(
        `SELECT id, title, narrative, type, tier, weight, reinforcement,
                epoch, tags, narrative_role, last_accessed
         FROM nodes WHERE id = ?`,
      );
    }
    if (!this.edgesStmt) {
      this.edgesStmt = this.db.prepare(
        `SELECT e.source_id, e.target_id, e.relation, n.title AS other_title
         FROM edges e
         JOIN nodes n ON n.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END
         WHERE e.source_id = ? OR e.target_id = ?`,
      );
    }

    type NodeRow = {
      id: string;
      title: string;
      narrative: string;
      type: string;
      tier: string;
      weight: number;
      reinforcement: number;
      epoch: string;
      tags: string;
      narrative_role: string;
      last_accessed: string;
    };

    type EdgeRow = {
      source_id: string;
      target_id: string;
      relation: string;
      other_title: string;
    };

    const node = this.nodeStmt.get(id) as NodeRow | undefined;
    if (!node) {
      return { text: `Node ${id} not found.`, path: id };
    }

    const edges = this.edgesStmt.all(id, id, id) as EdgeRow[];

    const parts: string[] = [
      `### [${node.id}] ${node.title}`,
      `type: ${node.type} | tier: ${node.tier} | weight: ${node.weight} | ` +
        `reinforcement: ${node.reinforcement} | epoch: ${node.epoch}`,
      `tags: ${node.tags}`,
      `last_accessed: ${node.last_accessed}`,
      "",
      node.narrative,
    ];

    if (edges.length > 0) {
      parts.push("", "Edges:");
      for (const e of edges) {
        if (e.source_id === id) {
          parts.push(`  → ${e.relation} → [${e.target_id}] ${e.other_title}`);
        } else {
          parts.push(`  ← ${e.relation} ← [${e.source_id}] ${e.other_title}`);
        }
      }
    }

    // Auto-reinforce on read
    if (this.config.autoReinforce) {
      this.reinforceNodes([id]);
    }

    return { text: parts.join("\n"), path: id };
  }

  private reinforceNodes(ids: string[]): void {
    if (!this.reinforceStmt) {
      this.reinforceStmt = this.db.prepare(
        `UPDATE nodes SET reinforcement = reinforcement + 1, last_accessed = date('now')
         WHERE id = ?`,
      );
    }
    for (const id of ids) {
      try {
        this.reinforceStmt.run(id);
      } catch (err) {
        log.warn(
          `graph memory: failed to reinforce ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
