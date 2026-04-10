// Octopus Orchestrator -- ArtifactService (M3-06)
//
// Standalone service for persisting and indexing produced outputs (logs,
// checkpoints, summaries, patches, reports, stdout/stderr slices). Artifacts
// are IMMUTABLE -- write-once, read-forever, no update, no delete, no CAS.
// The schema enforces this by omitting a `version` column on the artifacts
// table.
//
// Context docs:
//   - LLD $Core Domain Objects -- ArtifactRecord field list
//   - LLD $ArtifactService -- responsibilities
//   - schema.sql artifacts table -- immutable, no version column
//   - DECISIONS.md OCTO-DEC-033 -- boundary discipline
//
// Boundary discipline (OCTO-DEC-033):
//   Only `node:*` builtins and relative imports inside `src/octo/` are
//   permitted. No external dependencies.

import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { EventLogService } from "./event-log.ts";

// ──────────────────────────────────────────────────────────────────────────
// Domain types
// ──────────────────────────────────────────────────────────────────────────

const VALID_ARTIFACT_TYPES = [
  "summary",
  "log",
  "patch",
  "checkpoint",
  "report",
  "stdout-slice",
  "stderr-slice",
] as const;

export type ArtifactType = (typeof VALID_ARTIFACT_TYPES)[number];

export interface ArtifactRecord {
  artifact_id: string;
  artifact_type: ArtifactType;
  mission_id: string | null;
  grip_id: string | null;
  arm_id: string | null;
  storage_ref: string;
  metadata: Record<string, unknown> | null;
  created_at: number;
}

export type ArtifactInput = Omit<ArtifactRecord, "artifact_id" | "created_at"> & {
  created_at?: number;
};

// ──────────────────────────────────────────────────────────────────────────
// Raw SQLite row shape (metadata stored as TEXT `metadata_json`)
// ──────────────────────────────────────────────────────────────────────────

interface ArtifactRow {
  artifact_id: string;
  artifact_type: string;
  mission_id: string | null;
  grip_id: string | null;
  arm_id: string | null;
  storage_ref: string;
  metadata_json: string | null;
  created_at: number;
}

function rowToRecord(row: ArtifactRow): ArtifactRecord {
  return {
    artifact_id: row.artifact_id,
    artifact_type: row.artifact_type as ArtifactType,
    mission_id: row.mission_id,
    grip_id: row.grip_id,
    arm_id: row.arm_id,
    storage_ref: row.storage_ref,
    metadata:
      row.metadata_json !== null
        ? (JSON.parse(row.metadata_json) as Record<string, unknown>)
        : null,
    created_at: row.created_at,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// ArtifactService
// ──────────────────────────────────────────────────────────────────────────

export class ArtifactService {
  private readonly stmtInsert: StatementSync;
  private readonly stmtGetById: StatementSync;
  private readonly stmtListByMission: StatementSync;
  private readonly stmtListByArm: StatementSync;
  private readonly stmtListByGrip: StatementSync;

  constructor(
    private readonly db: DatabaseSync,
    private readonly eventLog: EventLogService,
  ) {
    this.stmtInsert = db.prepare(`
      INSERT INTO artifacts (artifact_id, artifact_type, mission_id, grip_id, arm_id, storage_ref, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.stmtGetById = db.prepare("SELECT * FROM artifacts WHERE artifact_id = ?");
    this.stmtListByMission = db.prepare(
      "SELECT * FROM artifacts WHERE mission_id = ? ORDER BY created_at DESC",
    );
    this.stmtListByArm = db.prepare(
      "SELECT * FROM artifacts WHERE arm_id = ? ORDER BY created_at DESC",
    );
    this.stmtListByGrip = db.prepare(
      "SELECT * FROM artifacts WHERE grip_id = ? ORDER BY created_at DESC",
    );
  }

  async record(input: ArtifactInput): Promise<ArtifactRecord> {
    if (!(VALID_ARTIFACT_TYPES as readonly string[]).includes(input.artifact_type)) {
      throw new Error(
        `ArtifactService.record: invalid artifact_type "${input.artifact_type}". ` +
          `Must be one of: ${VALID_ARTIFACT_TYPES.join(", ")}`,
      );
    }

    const artifactId = `art-${randomUUID()}`;
    const createdAt = input.created_at ?? Date.now();
    const metadataJson =
      input.metadata !== null && input.metadata !== undefined
        ? JSON.stringify(input.metadata)
        : null;

    this.stmtInsert.run(
      artifactId,
      input.artifact_type,
      input.mission_id,
      input.grip_id,
      input.arm_id,
      input.storage_ref,
      metadataJson,
      createdAt,
    );

    const record: ArtifactRecord = {
      artifact_id: artifactId,
      artifact_type: input.artifact_type,
      mission_id: input.mission_id,
      grip_id: input.grip_id,
      arm_id: input.arm_id,
      storage_ref: input.storage_ref,
      metadata: input.metadata,
      created_at: createdAt,
    };

    await this.eventLog.append({
      schema_version: 1,
      entity_type: "artifact",
      entity_id: artifactId,
      event_type: "artifact.recorded",
      actor: "artifact-service",
      payload: {
        artifact_type: input.artifact_type,
        mission_id: input.mission_id,
        grip_id: input.grip_id,
        arm_id: input.arm_id,
        storage_ref: input.storage_ref,
      },
    });

    return record;
  }

  get(artifactId: string): ArtifactRecord | null {
    const row = this.stmtGetById.get(artifactId) as unknown as ArtifactRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  listByMission(missionId: string): ArtifactRecord[] {
    const rows = this.stmtListByMission.all(missionId) as unknown as ArtifactRow[];
    return rows.map(rowToRecord);
  }

  listByArm(armId: string): ArtifactRecord[] {
    const rows = this.stmtListByArm.all(armId) as unknown as ArtifactRow[];
    return rows.map(rowToRecord);
  }

  listByGrip(gripId: string): ArtifactRecord[] {
    const rows = this.stmtListByGrip.all(gripId) as unknown as ArtifactRow[];
    return rows.map(rowToRecord);
  }
}
