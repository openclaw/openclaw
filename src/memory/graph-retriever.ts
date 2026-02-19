import type { DatabaseSync } from "node:sqlite";
import { MemoryGraphStore } from "./graph-store.js";
import { extractEntitiesWithLLM, type EntityExtractorConfig } from "./entity-extraction.js";

export type GraphRetrieverParams = {
  db: DatabaseSync;
  entityConfig?: EntityExtractorConfig;
};

export type GraphSearchResult = {
  chunkId: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
  entityMatch: boolean;
  relatedEntities: string[];
};

export class MemoryGraphRetriever {
  private readonly graph: MemoryGraphStore;
  private readonly entityConfig?: EntityExtractorConfig;

  constructor(params: GraphRetrieverParams) {
    this.graph = new MemoryGraphStore({ db: params.db });
    this.entityConfig = params.entityConfig;
  }

  async extractAndStore(chunkId: string, text: string, path?: string): Promise<void> {
    if (!this.entityConfig) {
      return;
    }

    const result = await extractEntitiesWithLLM({
      text,
      config: this.entityConfig,
      maxEntities: 30,
    });

    const context = path ? `From ${path}` : undefined;
    this.graph.upsertEntities(result.entities, chunkId, context);
    this.graph.upsertRelationships(result.relationships);
  }

  async searchByEntities(
    query: string,
    options: {
      maxResults?: number;
      entityBoost?: number;
    } = {},
  ): Promise<GraphSearchResult[]> {
    const { maxResults = 20, entityBoost = 1.5 } = options;

    const queryEntities = await this.extractQueryEntities(query);
    if (queryEntities.length === 0) {
      return [];
    }

    const chunkScores = new Map<string, { score: number; entities: string[] }>();

    for (const entity of queryEntities) {
      const related = this.graph.getRelatedEntities(entity.id, 1);
      const entityIds = [entity.id, ...related.map((r) => r.subjectId), ...related.map((r) => r.objectId)];

      for (const entityId of entityIds) {
        const mentions = this.getChunkIdsForEntity(entityId);
        for (const chunkId of mentions) {
          const existing = chunkScores.get(chunkId);
          if (existing) {
            existing.score += entityBoost;
            if (!existing.entities.includes(entity.name)) {
              existing.entities.push(entity.name);
            }
          } else {
            chunkScores.set(chunkId, {
              score: entityBoost,
              entities: [entity.name],
            });
          }
        }
      }
    }

    const results: GraphSearchResult[] = [];
    for (const [chunkId, data] of chunkScores.entries()) {
      const chunkInfo = this.getChunkInfo(chunkId);
      if (chunkInfo) {
        results.push({
          chunkId,
          path: chunkInfo.path,
          startLine: chunkInfo.startLine,
          endLine: chunkInfo.endLine,
          score: data.score,
          snippet: chunkInfo.text.slice(0, 300),
          source: chunkInfo.source,
          entityMatch: true,
          relatedEntities: data.entities,
        });
      }
    }

    return results.toSorted((a, b) => b.score - a.score).slice(0, maxResults);
  }

  private async extractQueryEntities(query: string): Promise<Array<{ id: string; name: string }>> {
    if (!this.entityConfig) {
      const entities = this.graph.findEntitiesByName(query, 10);
      return entities.map((e) => ({ id: e.id, name: e.name }));
    }

    const result = await extractEntitiesWithLLM({
      text: query,
      config: this.entityConfig,
      maxEntities: 10,
    });

    return result.entities.map((e) => ({
      id: generateEntityIdForQuery(e.name, e.type),
      name: e.name,
    }));
  }

  private getChunkIdsForEntity(entityId: string): string[] {
    try {
      const rows = this.graph
        .getDb()
        .prepare(`SELECT chunk_id FROM entity_mentions WHERE entity_id = ? LIMIT 50`)
        .all(entityId) as Array<{ chunk_id: string }>;
      return rows.map((row) => row.chunk_id);
    } catch {
      return [];
    }
  }

  private getChunkInfo(chunkId: string): {
    path: string;
    startLine: number;
    endLine: number;
    text: string;
    source: string;
  } | null {
    try {
      const row = this.graph
        .getDb()
        .prepare(`SELECT path, start_line, end_line, text, source FROM chunks WHERE id = ?`)
        .get(chunkId) as
        | {
            path: string;
            start_line: number;
            end_line: number;
            text: string;
            source: string;
          }
        | undefined;

      if (!row) {
        return null;
      }

      return {
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        text: row.text,
        source: row.source,
      };
    } catch {
      return null;
    }
  }

  getGraphStatus(): {
    entityCount: number;
    relationshipCount: number;
    mentionCount: number;
  } {
    return this.graph.getStatus();
  }
}

function generateEntityIdForQuery(name: string, type: string): string {
  const normalized = `${type}:${name.toLowerCase().trim()}`;
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}
