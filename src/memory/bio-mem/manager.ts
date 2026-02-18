import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { EmbeddingProvider } from "../embeddings.js";
import { cosineSimilarity } from "../internal.js";
import { ensureBioMemSchema } from "./schema.js";
import type { EpisodeEvent, SemanticNode } from "./types.js";

const DEFAULT_MAX_EPISODE_INJECT = 3;
const DEFAULT_MAX_SEMANTIC_INJECT = 5;
const DEFAULT_PATTERN_INTERVAL = 5;

export class BioMemManager {
  private readonly db: DatabaseSync;
  private readonly embeddingProvider: EmbeddingProvider | null;

  constructor(db: DatabaseSync, embeddingProvider: EmbeddingProvider | null) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    ensureBioMemSchema(db);
  }

  async storeEpisode(
    event: Omit<EpisodeEvent, "id" | "timestamp">,
  ): Promise<string> {
    const id = randomUUID();
    const timestamp = Date.now();
    this.db
      .prepare(
        `INSERT INTO bio_episodes
           (id, session_key, timestamp, user_intent, action_taken, outcome, raw_json, embedding, importance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        event.session_key,
        timestamp,
        event.user_intent,
        event.action_taken,
        event.outcome,
        event.raw_json,
        event.embedding,
        event.importance,
      );
    return id;
  }

  async searchEpisodes(
    query: string,
    maxResults = 3,
  ): Promise<EpisodeEvent[]> {
    if (!this.embeddingProvider) {
      return this.searchEpisodesKeyword(query, maxResults);
    }
    try {
      const queryVec = await this.embeddingProvider.embedQuery(query);
      return this.searchEpisodesVector(queryVec, maxResults);
    } catch {
      return this.searchEpisodesKeyword(query, maxResults);
    }
  }

  private searchEpisodesVector(
    queryVec: number[],
    maxResults: number,
  ): EpisodeEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_key, timestamp, user_intent, action_taken, outcome,
                raw_json, embedding, importance
           FROM bio_episodes
          WHERE embedding IS NOT NULL
          ORDER BY timestamp DESC
          LIMIT 200`,
      )
      .all() as Array<EpisodeEvent & { embedding: string }>;

    const scored = rows
      .map((row) => {
        try {
          const vec = JSON.parse(row.embedding) as number[];
          const score = cosineSimilarity(queryVec, vec);
          return { row, score };
        } catch {
          return { row, score: 0 };
        }
      })
      .filter((entry) => Number.isFinite(entry.score) && entry.score > 0);

    return scored
      .toSorted((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((entry) => entry.row);
  }

  private searchEpisodesKeyword(
    query: string,
    maxResults: number,
  ): EpisodeEvent[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1);
    if (terms.length === 0) {
      return this.getRecentEpisodes(maxResults);
    }
    const rows = this.db
      .prepare(
        `SELECT id, session_key, timestamp, user_intent, action_taken, outcome,
                raw_json, embedding, importance
           FROM bio_episodes
          ORDER BY timestamp DESC
          LIMIT 100`,
      )
      .all() as EpisodeEvent[];

    const scored = rows.map((row) => {
      const text =
        `${row.user_intent} ${row.action_taken} ${row.outcome}`.toLowerCase();
      const hits = terms.filter((t) => text.includes(t)).length;
      return { row, score: hits / terms.length };
    });

    return scored
      .filter((entry) => entry.score > 0)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map((entry) => entry.row);
  }

  private getRecentEpisodes(maxResults: number): EpisodeEvent[] {
    return this.db
      .prepare(
        `SELECT id, session_key, timestamp, user_intent, action_taken, outcome,
                raw_json, embedding, importance
           FROM bio_episodes
          ORDER BY timestamp DESC
          LIMIT ?`,
      )
      .all(maxResults) as EpisodeEvent[];
  }

  getSemanticNodes(
    _query?: string,
    maxResults = DEFAULT_MAX_SEMANTIC_INJECT,
  ): SemanticNode[] {
    // Semantic detection implemented in PR 3; returns empty until then.
    return this.db
      .prepare(
        `SELECT id, type, label, value, evidence_count, created_at, updated_at
           FROM bio_semantic_nodes
          ORDER BY evidence_count DESC, updated_at DESC
          LIMIT ?`,
      )
      .all(maxResults) as SemanticNode[];
  }

  async buildContextInjection(
    userMessage: string,
    options?: { maxEpisodes?: number; maxNodes?: number },
  ): Promise<string> {
    const maxEpisodes = options?.maxEpisodes ?? DEFAULT_MAX_EPISODE_INJECT;
    const maxNodes = options?.maxNodes ?? DEFAULT_MAX_SEMANTIC_INJECT;

    const episodes = await this.searchEpisodes(userMessage, maxEpisodes);
    const nodes = this.getSemanticNodes(userMessage, maxNodes);

    if (episodes.length === 0 && nodes.length === 0) {
      return "";
    }

    const lines: string[] = [];

    if (episodes.length > 0) {
      lines.push("[Episodes - Most Relevant]");
      for (const ep of episodes) {
        const week = formatWeek(ep.timestamp);
        lines.push(
          `• [${week}] ${ep.user_intent} → ${ep.action_taken} → ${ep.outcome}`,
        );
      }
    }

    if (nodes.length > 0) {
      if (lines.length > 0) {
        lines.push("");
      }
      lines.push("[User Knowledge Graph]");
      for (const node of nodes) {
        lines.push(`• ${capitalize(node.type)}: ${node.label}: ${node.value}`);
      }
    }

    return lines.join("\n");
  }

  getEpisodeCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM bio_episodes`)
      .get() as { cnt: number };
    return row.cnt;
  }

  shouldRunPatternDetection(interval = DEFAULT_PATTERN_INTERVAL): boolean {
    const lastRow = this.db
      .prepare(
        `SELECT value FROM bio_meta WHERE key = 'last_pattern_detection_episode_count'`,
      )
      .get() as { value: string } | undefined;
    const lastCount = lastRow ? parseInt(lastRow.value, 10) : 0;
    return this.getEpisodeCount() - lastCount >= interval;
  }

  markPatternDetectionRun(): void {
    const count = this.getEpisodeCount();
    this.db
      .prepare(
        `INSERT INTO bio_meta (key, value) VALUES ('last_pattern_detection_episode_count', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(String(count));
  }
}

function formatWeek(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getUTCFullYear();
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(
    ((d.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getUTCDay() + 1) / 7,
  );
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function capitalize(str: string): string {
  if (!str) {
    return str;
  }
  return str.charAt(0).toUpperCase() + str.slice(1);
}
