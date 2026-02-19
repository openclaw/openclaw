import type { DatabaseSync } from "node:sqlite";
import type { ExtractedEntity, ExtractedRelationship, EntityType } from "./entity-extraction.js";
import { generateEntityId } from "./entity-extraction.js";

export type GraphEntity = {
  id: string;
  name: string;
  type: EntityType;
  mentions: number;
  createdAt: number;
  updatedAt: number;
};

export type GraphRelationship = {
  id: string;
  subjectId: string;
  predicate: string;
  objectId: string;
  confidence: number;
  createdAt: number;
};

export type GraphStoreParams = {
  db: DatabaseSync;
};

export class MemoryGraphStore {
  private readonly db: DatabaseSync;

  constructor(params: GraphStoreParams) {
    this.db = params.db;
  }

  upsertEntities(entities: ExtractedEntity[], chunkId: string, context?: string): void {
    const now = Date.now();
    const insertEntity = this.db.prepare(`
      INSERT INTO entities (id, name, type, mentions, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        mentions = mentions + 1,
        updated_at = ?
    `);

    const insertMention = this.db.prepare(`
      INSERT OR REPLACE INTO entity_mentions (entity_id, chunk_id, context, offset, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.db.exec(`PRAGMA foreign_keys = ON`);

    for (const entity of entities) {
      if (!entity.name.trim()) {
        continue;
      }

      const id = generateEntityId(entity.name, entity.type);

      insertEntity.run(id, entity.name, entity.type, now, now, now);
      try {
        insertMention.run(id, chunkId, context ?? entity.context ?? null, entity.offset ?? null, now);
      } catch {
        // Chunk may not exist in some test scenarios
      }
    }
  }

  upsertRelationships(relationships: ExtractedRelationship[]): void {
    const now = Date.now();
    const insertRel = this.db.prepare(`
      INSERT OR REPLACE INTO relationships (id, subject_id, predicate, object_id, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const rel of relationships) {
      if (!rel.subject.trim() || !rel.object.trim()) {
        continue;
      }

      const subjectId = generateEntityId(rel.subject, "CUSTOM");
      const objectId = generateEntityId(rel.object, "CUSTOM");
      const id = generateEntityId(`${subjectId}:${rel.predicate}:${objectId}`, "REL");

      try {
        insertRel.run(id, subjectId, rel.predicate, objectId, rel.confidence, now);
      } catch {
        // Subject or object entity may not exist
      }
    }
  }

  getEntitiesByChunk(chunkId: string): GraphEntity[] {
    const rows = this.db
      .prepare(`
        SELECT e.id, e.name, e.type, e.mentions, e.created_at, e.updated_at
        FROM entities e
        INNER JOIN entity_mentions em ON e.id = em.entity_id
        WHERE em.chunk_id = ?
        ORDER BY e.mentions DESC
      `)
      .all(chunkId) as Array<{
      id: string;
      name: string;
      type: string;
      mentions: number;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type as EntityType,
      mentions: row.mentions,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getRelatedEntities(entityId: string, maxHops: number = 1): GraphRelationship[] {
    if (maxHops <= 0) {
      return [];
    }

    const rows = this.db
      .prepare(`
        SELECT id, subject_id, predicate, object_id, confidence, created_at
        FROM relationships
        WHERE subject_id = ? OR object_id = ?
        LIMIT ?
      `)
      .all(entityId, entityId, 100) as Array<{
      id: string;
      subject_id: string;
      predicate: string;
      object_id: string;
      confidence: number;
      created_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      subjectId: row.subject_id,
      predicate: row.predicate,
      objectId: row.object_id,
      confidence: row.confidence,
      createdAt: row.created_at,
    }));
  }

  findEntitiesByName(name: string, limit: number = 20): GraphEntity[] {
    const rows = this.db
      .prepare(`
        SELECT id, name, type, mentions, created_at, updated_at
        FROM entities
        WHERE name LIKE ?
        ORDER BY mentions DESC
        LIMIT ?
      `)
      .all(`%${name}%`, limit) as Array<{
      id: string;
      name: string;
      type: string;
      mentions: number;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type as EntityType,
      mentions: row.mentions,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getEntitiesByType(type: EntityType, limit: number = 50): GraphEntity[] {
    const rows = this.db
      .prepare(`
        SELECT id, name, type, mentions, created_at, updated_at
        FROM entities
        WHERE type = ?
        ORDER BY mentions DESC
        LIMIT ?
      `)
      .all(type, limit) as Array<{
      id: string;
      name: string;
      type: string;
      mentions: number;
      created_at: number;
      updated_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type as EntityType,
      mentions: row.mentions,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getChunkEntityIds(chunkId: string): string[] {
    const rows = this.db
      .prepare(`SELECT entity_id FROM entity_mentions WHERE chunk_id = ?`)
      .all(chunkId) as Array<{ entity_id: string }>;

    return rows.map((row) => row.entity_id);
  }

  deleteEntitiesForChunk(chunkId: string): void {
    this.db.prepare(`DELETE FROM entity_mentions WHERE chunk_id = ?`).run(chunkId);
    this.db.exec(`
      DELETE FROM entities
      WHERE id NOT IN (SELECT entity_id FROM entity_mentions)
    `);
  }

  getStatus(): {
    entityCount: number;
    relationshipCount: number;
    mentionCount: number;
  } {
    const entityCount =
      (this.db.prepare(`SELECT COUNT(*) as c FROM entities`).get() as { c: number }).c;
    const relationshipCount =
      (this.db.prepare(`SELECT COUNT(*) as c FROM relationships`).get() as { c: number }).c;
    const mentionCount =
      (this.db.prepare(`SELECT COUNT(*) as c FROM entity_mentions`).get() as { c: number }).c;

    return { entityCount, relationshipCount, mentionCount };
  }

  getDb(): DatabaseSync {
    return this.db;
  }
}
