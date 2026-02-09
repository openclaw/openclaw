/**
 * OpenClaw AGI - Graph Memory
 *
 * Entity–relation knowledge graph stored in SQLite.
 * Tracks code entities (functions, classes, modules) and their relationships
 * (imports, calls, extends, uses) for codebase understanding.
 *
 * Uses SQLite for local-first operation. Designed to be upgradeable
 * to a graph database (Neo4j) if/when needed.
 *
 * Uses the shared DatabaseManager — never creates its own DB connection.
 *
 * @module agi/graph
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getDatabase, jsonToSql, sqlToJson } from "../shared/db.js";

const log = createSubsystemLogger("agi:graph");

// ============================================================================
// TYPES
// ============================================================================

export type EntityType =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "module"
  | "file"
  | "variable"
  | "constant"
  | "enum"
  | "namespace"
  | "component"
  | "hook"
  | "api_endpoint"
  | "database_table"
  | "test"
  | "config"
  | "concept"
  | "person"
  | "other";

export type RelationType =
  | "imports"
  | "exports"
  | "calls"
  | "extends"
  | "implements"
  | "uses"
  | "depends_on"
  | "tests"
  | "defines"
  | "contains"
  | "references"
  | "related_to"
  | "child_of"
  | "owner_of";

export interface GraphEntity {
  id: string;
  agentId: string;
  type: EntityType;
  name: string;
  description?: string;
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface GraphRelation {
  id: string;
  fromEntity: string;
  toEntity: string;
  type: RelationType;
  strength: number; // 0.0–1.0 (higher = stronger relationship)
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface PathResult {
  entities: GraphEntity[];
  relations: GraphRelation[];
  hops: number;
}

export interface NeighborhoodResult {
  center: GraphEntity;
  neighbors: Array<{
    entity: GraphEntity;
    relation: GraphRelation;
    direction: "incoming" | "outgoing";
  }>;
}

// ============================================================================
// GRAPH MEMORY MANAGER
// ============================================================================

export class GraphMemoryManager {
  private db: DatabaseSync;
  private agentId: string;

  constructor(agentId: string, dbPath?: string) {
    this.agentId = agentId;
    this.db = getDatabase(agentId, dbPath);
    log.info(`GraphMemoryManager initialized for agent: ${agentId}`);
  }

  // ============================================================================
  // ENTITY CRUD
  // ============================================================================

  /** Create or update an entity */
  upsertEntity(config: {
    type: EntityType;
    name: string;
    description?: string;
    file?: string;
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
    metadata?: Record<string, unknown>;
  }): GraphEntity {
    const now = new Date().toISOString();

    // Check if entity already exists by name + type + file
    const existing = this.findEntity(config.name, config.type, config.file);
    if (existing) {
      // Update existing entity
      this.db
        .prepare(
          `UPDATE graph_entities SET
          description = COALESCE(?, description),
          file = COALESCE(?, file),
          line = COALESCE(?, line),
          column_num = COALESCE(?, column_num),
          end_line = COALESCE(?, end_line),
          end_column = COALESCE(?, end_column),
          metadata = COALESCE(?, metadata),
          updated_at = ?
        WHERE id = ?`,
        )
        .run(
          config.description || null,
          config.file || null,
          config.line || null,
          config.column || null,
          config.endLine || null,
          config.endColumn || null,
          jsonToSql(config.metadata),
          now,
          existing.id,
        );

      log.debug(`Updated entity: ${config.name} (${config.type})`);
      return { ...existing, ...config, updatedAt: new Date(now) };
    }

    // Create new entity
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO graph_entities (
        id, agent_id, type, name, description, file, line, column_num,
        end_line, end_column, metadata, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.agentId,
        config.type,
        config.name,
        config.description || null,
        config.file || null,
        config.line || null,
        config.column || null,
        config.endLine || null,
        config.endColumn || null,
        jsonToSql(config.metadata),
        now,
        now,
      );

    log.info(`Created entity: ${config.name} (${config.type})`);
    return {
      id,
      agentId: this.agentId,
      type: config.type,
      name: config.name,
      description: config.description,
      file: config.file,
      line: config.line,
      column: config.column,
      endLine: config.endLine,
      endColumn: config.endColumn,
      metadata: config.metadata,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
  }

  /** Find an entity by name, type, and optional file */
  findEntity(name: string, type?: EntityType, file?: string): GraphEntity | null {
    let sql = "SELECT * FROM graph_entities WHERE agent_id = ? AND name = ?";
    const params: (string | number | null)[] = [this.agentId, name];

    if (type) {
      sql += " AND type = ?";
      params.push(type);
    }
    if (file) {
      sql += " AND file = ?";
      params.push(file);
    }
    sql += " LIMIT 1";

    const row = this.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    return row ? this.rowToEntity(row) : null;
  }

  /** Get an entity by ID */
  getEntity(entityId: string): GraphEntity | null {
    const row = this.db.prepare("SELECT * FROM graph_entities WHERE id = ?").get(entityId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToEntity(row) : null;
  }

  /** Delete an entity and its relations */
  deleteEntity(entityId: string): void {
    this.db
      .prepare("DELETE FROM graph_relations WHERE from_entity = ? OR to_entity = ?")
      .run(entityId, entityId);
    this.db.prepare("DELETE FROM graph_entities WHERE id = ?").run(entityId);
    log.info(`Deleted entity: ${entityId}`);
  }

  /** List entities with optional filters */
  listEntities(filters?: {
    type?: EntityType;
    file?: string;
    nameContains?: string;
    limit?: number;
  }): GraphEntity[] {
    let sql = "SELECT * FROM graph_entities WHERE agent_id = ?";
    const params: (string | number | null)[] = [this.agentId];

    if (filters?.type) {
      sql += " AND type = ?";
      params.push(filters.type);
    }
    if (filters?.file) {
      sql += " AND file = ?";
      params.push(filters.file);
    }
    if (filters?.nameContains) {
      sql += " AND name LIKE ?";
      params.push(`%${filters.nameContains}%`);
    }

    sql += " ORDER BY updated_at DESC";
    if (filters?.limit) {
      sql += ` LIMIT ${filters.limit}`;
    }

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEntity(row));
  }

  // ============================================================================
  // RELATION CRUD
  // ============================================================================

  /** Create a relation between two entities */
  addRelation(config: {
    fromEntity: string;
    toEntity: string;
    type: RelationType;
    strength?: number;
    metadata?: Record<string, unknown>;
  }): GraphRelation {
    // Validate both entities exist
    if (!this.getEntity(config.fromEntity)) {
      throw new Error(`Source entity not found: ${config.fromEntity}`);
    }
    if (!this.getEntity(config.toEntity)) {
      throw new Error(`Target entity not found: ${config.toEntity}`);
    }

    // Check for duplicate
    const existing = this.findRelation(config.fromEntity, config.toEntity, config.type);
    if (existing) {
      // Strengthen existing relation
      const newStrength = Math.min(1.0, existing.strength + (config.strength || 0.1));
      this.db
        .prepare("UPDATE graph_relations SET strength = ? WHERE id = ?")
        .run(newStrength, existing.id);
      log.debug(
        `Strengthened relation ${config.type}: ${config.fromEntity} → ${config.toEntity} (${newStrength.toFixed(2)})`,
      );
      return { ...existing, strength: newStrength };
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO graph_relations (id, from_entity, to_entity, type, strength, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        config.fromEntity,
        config.toEntity,
        config.type,
        config.strength || 1.0,
        jsonToSql(config.metadata),
        now,
      );

    log.info(`Created relation ${config.type}: ${config.fromEntity} → ${config.toEntity}`);
    return {
      id,
      fromEntity: config.fromEntity,
      toEntity: config.toEntity,
      type: config.type,
      strength: config.strength || 1.0,
      metadata: config.metadata,
      createdAt: new Date(now),
    };
  }

  /** Find a specific relation */
  findRelation(fromEntity: string, toEntity: string, type: RelationType): GraphRelation | null {
    const row = this.db
      .prepare(
        `SELECT * FROM graph_relations
       WHERE from_entity = ? AND to_entity = ? AND type = ?`,
      )
      .get(fromEntity, toEntity, type) as Record<string, unknown> | undefined;
    return row ? this.rowToRelation(row) : null;
  }

  /** Get all relations for an entity (incoming + outgoing) */
  getRelations(entityId: string): GraphRelation[] {
    const rows = this.db
      .prepare("SELECT * FROM graph_relations WHERE from_entity = ? OR to_entity = ?")
      .all(entityId, entityId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToRelation(row));
  }

  /** Delete a relation */
  deleteRelation(relationId: string): void {
    this.db.prepare("DELETE FROM graph_relations WHERE id = ?").run(relationId);
  }

  // ============================================================================
  // GRAPH TRAVERSAL
  // ============================================================================

  /** Get neighborhood of an entity (1-hop) */
  getNeighborhood(entityId: string): NeighborhoodResult | null {
    const center = this.getEntity(entityId);
    if (!center) {
      return null;
    }

    const outgoing = this.db
      .prepare(
        `SELECT r.*, e.* FROM graph_relations r
       JOIN graph_entities e ON e.id = r.to_entity
       WHERE r.from_entity = ?`,
      )
      .all(entityId) as Array<Record<string, unknown>>;

    const incoming = this.db
      .prepare(
        `SELECT r.*, e.* FROM graph_relations r
       JOIN graph_entities e ON e.id = r.from_entity
       WHERE r.to_entity = ?`,
      )
      .all(entityId) as Array<Record<string, unknown>>;

    const neighbors: NeighborhoodResult["neighbors"] = [];

    for (const row of outgoing) {
      neighbors.push({
        entity: this.rowToEntity(row),
        relation: this.rowToRelation(row),
        direction: "outgoing",
      });
    }
    for (const row of incoming) {
      neighbors.push({
        entity: this.rowToEntity(row),
        relation: this.rowToRelation(row),
        direction: "incoming",
      });
    }

    return { center, neighbors };
  }

  /**
   * Find shortest path between two entities (BFS up to maxHops).
   *
   * Returns the path as a list of entities and relations, or null if unreachable.
   */
  findPath(fromEntityId: string, toEntityId: string, maxHops = 5): PathResult | null {
    if (fromEntityId === toEntityId) {
      const entity = this.getEntity(fromEntityId);
      return entity ? { entities: [entity], relations: [], hops: 0 } : null;
    }

    // BFS
    const visited = new Set<string>([fromEntityId]);
    const parentMap = new Map<string, { entityId: string; relation: GraphRelation }>();
    let frontier: string[] = [fromEntityId];

    for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
      const nextFrontier: string[] = [];

      for (const currentId of frontier) {
        const relations = this.getRelations(currentId);
        for (const rel of relations) {
          const neighborId = rel.fromEntity === currentId ? rel.toEntity : rel.fromEntity;
          if (visited.has(neighborId)) {
            continue;
          }

          visited.add(neighborId);
          parentMap.set(neighborId, { entityId: currentId, relation: rel });

          if (neighborId === toEntityId) {
            // Reconstruct path
            return this.reconstructPath(fromEntityId, toEntityId, parentMap);
          }

          nextFrontier.push(neighborId);
        }
      }
      frontier = nextFrontier;
    }

    return null; // No path found within maxHops
  }

  /** Find entities related to a set of files */
  getEntitiesForFiles(filePaths: string[]): GraphEntity[] {
    if (filePaths.length === 0) {
      return [];
    }

    const placeholders = filePaths.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM graph_entities
       WHERE agent_id = ? AND file IN (${placeholders})
       ORDER BY name`,
      )
      .all(this.agentId, ...filePaths) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToEntity(row));
  }

  // ============================================================================
  // STATISTICS
  // ============================================================================

  getStats(): {
    totalEntities: number;
    totalRelations: number;
    entityTypes: Record<string, number>;
    relationTypes: Record<string, number>;
  } {
    type CountRow = { count: number };
    type TypeCountRow = { type: string; count: number };

    const entities = this.db
      .prepare("SELECT COUNT(*) as count FROM graph_entities WHERE agent_id = ?")
      .get(this.agentId) as CountRow;

    const relations = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM graph_relations
       WHERE from_entity IN (SELECT id FROM graph_entities WHERE agent_id = ?)`,
      )
      .get(this.agentId) as CountRow;

    const entityTypes = this.db
      .prepare(
        `SELECT type, COUNT(*) as count FROM graph_entities
       WHERE agent_id = ? GROUP BY type`,
      )
      .all(this.agentId) as TypeCountRow[];

    const relationTypes = this.db
      .prepare(
        `SELECT type, COUNT(*) as count FROM graph_relations
       WHERE from_entity IN (SELECT id FROM graph_entities WHERE agent_id = ?)
       GROUP BY type`,
      )
      .all(this.agentId) as TypeCountRow[];

    return {
      totalEntities: entities.count,
      totalRelations: relations.count,
      entityTypes: Object.fromEntries(entityTypes.map((r) => [r.type, r.count])),
      relationTypes: Object.fromEntries(relationTypes.map((r) => [r.type, r.count])),
    };
  }

  // ============================================================================
  // BULK OPERATIONS
  // ============================================================================

  /** Clear all graph data for the agent */
  clear(): void {
    this.db
      .prepare(
        `DELETE FROM graph_relations
       WHERE from_entity IN (SELECT id FROM graph_entities WHERE agent_id = ?)`,
      )
      .run(this.agentId);
    this.db.prepare("DELETE FROM graph_entities WHERE agent_id = ?").run(this.agentId);
    log.info("Cleared all graph data");
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================

  private rowToEntity(row: Record<string, unknown>): GraphEntity {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      type: row.type as EntityType,
      name: row.name as string,
      description: (row.description as string) || undefined,
      file: (row.file as string) || undefined,
      line: (row.line as number) || undefined,
      column: (row.column_num as number) || undefined,
      endLine: (row.end_line as number) || undefined,
      endColumn: (row.end_column as number) || undefined,
      metadata: sqlToJson<Record<string, unknown>>(row.metadata as string | null),
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }

  private rowToRelation(row: Record<string, unknown>): GraphRelation {
    return {
      id: row.id as string,
      fromEntity: row.from_entity as string,
      toEntity: row.to_entity as string,
      type: row.type as RelationType,
      strength: row.strength as number,
      metadata: sqlToJson<Record<string, unknown>>(row.metadata as string | null),
      createdAt: new Date(row.created_at as string),
    };
  }

  private reconstructPath(
    fromEntityId: string,
    toEntityId: string,
    parentMap: Map<string, { entityId: string; relation: GraphRelation }>,
  ): PathResult {
    const entities: GraphEntity[] = [];
    const relations: GraphRelation[] = [];

    let current = toEntityId;
    while (current !== fromEntityId) {
      const parent = parentMap.get(current);
      if (!parent) {
        break;
      }

      const entity = this.getEntity(current);
      if (entity) {
        entities.unshift(entity);
      }
      relations.unshift(parent.relation);
      current = parent.entityId;
    }

    // Add start entity
    const startEntity = this.getEntity(fromEntityId);
    if (startEntity) {
      entities.unshift(startEntity);
    }

    return { entities, relations, hops: relations.length };
  }
}

// ============================================================================
// FACTORY
// ============================================================================

const graphManagers = new Map<string, GraphMemoryManager>();

export function getGraphMemory(agentId: string): GraphMemoryManager {
  if (!graphManagers.has(agentId)) {
    graphManagers.set(agentId, new GraphMemoryManager(agentId));
  }
  return graphManagers.get(agentId)!;
}
