// Octopus Orchestrator — RegistryService (M1-02)
//
// Typed access layer over the SQLite registry created by M1-01
// (src/octo/head/storage/migrate.ts + schema.sql). Provides:
//
//   - get / put / list / casUpdate methods for missions, arms, grips, claims
//   - CAS (compare-and-swap) semantics on the `version` column: callers
//     pass the version they expect; on mismatch we throw `ConflictError`
//   - JSON (de)serialization of `spec_json` columns with TypeBox validation
//     so storage drift surfaces immediately
//
// Context docs:
//   - LLD §Core Domain Objects — MissionRecord, ArmRecord, GripRecord,
//     ClaimRecord field lists
//   - LLD §Control Plane Services (RegistryService) — service contract
//   - LLD §Storage Choices — CAS via monotonic `version` column
//   - DECISIONS.md OCTO-DEC-010 — SQLite for MVP storage
//
// Boundary discipline (OCTO-DEC-033):
//   This file lives outside `src/octo/adapters/openclaw/**`, so it must
//   not import from `src/infra/*` or other OpenClaw internals. Allowed
//   imports: `node:*` builtins, `@sinclair/typebox`, and relative paths
//   inside `src/octo/`. The style here intentionally mirrors
//   `src/tasks/task-registry.store.sqlite.ts` (prepared statements,
//   typed Row aliases) without importing from it.
//
// Concurrency model:
//   The MVP control plane is single-process / single-writer, but
//   `casUpdate*` is still implemented as a transaction-wrapped UPDATE +
//   re-SELECT so that future multi-writer scenarios (and the
//   acceptance-criterion concurrent test) get correct exactly-one-wins
//   semantics from SQLite's writer serialization.

import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { Value } from "@sinclair/typebox/value";
import {
  ArmSpecSchema,
  GripSpecSchema,
  MissionSpecSchema,
  type ArmSpec,
  type GripSpec,
  type MissionSpec,
} from "../wire/schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// Domain record types
//
// These are what RegistryService returns to callers. They are distinct
// from the wire spec types because records carry runtime state (state,
// version, timestamps, lease info) on top of the spec. The field shapes
// match the schema.sql column lists exactly — when in doubt, schema.sql
// is the authority.
// ──────────────────────────────────────────────────────────────────────────

export interface MissionRecord {
  mission_id: string;
  title: string;
  owner: string;
  status: string;
  policy_profile_ref: string | null;
  spec: MissionSpec;
  metadata: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
  version: number;
}

export interface ArmRecord {
  arm_id: string;
  mission_id: string;
  node_id: string;
  adapter_type: string;
  runtime_name: string;
  agent_id: string;
  task_ref: string | null;
  state: string;
  current_grip_id: string | null;
  lease_owner: string | null;
  lease_expiry_ts: number | null;
  session_ref: Record<string, unknown> | null;
  checkpoint_ref: string | null;
  health_status: string | null;
  restart_count: number;
  policy_profile: string | null;
  spec: ArmSpec;
  created_at: number;
  updated_at: number;
  version: number;
}

export interface GripRecord {
  grip_id: string;
  mission_id: string;
  type: string;
  input_ref: string | null;
  priority: number;
  assigned_arm_id: string | null;
  status: string;
  timeout_s: number | null;
  side_effecting: boolean;
  idempotency_key: string | null;
  result_ref: string | null;
  spec: GripSpec;
  created_at: number;
  updated_at: number;
  version: number;
}

export interface ClaimRecord {
  claim_id: string;
  mission_id: string | null;
  grip_id: string | null;
  resource_type: string;
  resource_key: string;
  owner_arm_id: string;
  mode: "exclusive" | "shared-read";
  lease_expiry_ts: number;
  created_at: number;
  updated_at: number;
  version: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Errors
// ──────────────────────────────────────────────────────────────────────────

export type RegistryEntity = "mission" | "arm" | "grip" | "claim";

/**
 * Thrown by `casUpdate*` when the `expectedVersion` does not match the
 * row's current `version`, OR when the row does not exist at all
 * (`actualVersion === null`). Carries enough structured detail for
 * callers to retry, refetch, or report.
 */
export class ConflictError extends Error {
  constructor(
    public readonly entity: RegistryEntity,
    public readonly id: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number | null,
  ) {
    const reason = actualVersion === null ? "row not found" : `actual=${actualVersion}`;
    super(`CAS conflict on ${entity} ${id}: expected=${expectedVersion}, ${reason}`);
    this.name = "ConflictError";
  }
}

/**
 * Thrown by `put*` when a row with the given primary key already exists.
 * Distinct from ConflictError because the caller did not claim a CAS
 * expectation — they tried to create a fresh row and lost the race (or
 * passed a duplicate id by mistake).
 */
export class DuplicateError extends Error {
  constructor(
    public readonly entity: RegistryEntity,
    public readonly id: string,
  ) {
    super(`duplicate ${entity} id: ${id}`);
    this.name = "DuplicateError";
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Row type aliases — exact shape returned by SQLite for each table
// ──────────────────────────────────────────────────────────────────────────

interface MissionRow {
  mission_id: string;
  title: string;
  owner: string;
  status: string;
  policy_profile_ref: string | null;
  spec_json: string;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
  version: number;
}

interface ArmRow {
  arm_id: string;
  mission_id: string;
  node_id: string;
  adapter_type: string;
  runtime_name: string;
  agent_id: string;
  task_ref: string | null;
  state: string;
  current_grip_id: string | null;
  lease_owner: string | null;
  lease_expiry_ts: number | null;
  session_ref_json: string | null;
  checkpoint_ref: string | null;
  health_status: string | null;
  restart_count: number;
  policy_profile: string | null;
  spec_json: string;
  created_at: number;
  updated_at: number;
  version: number;
}

interface GripRow {
  grip_id: string;
  mission_id: string;
  type: string;
  input_ref: string | null;
  priority: number;
  assigned_arm_id: string | null;
  status: string;
  timeout_s: number | null;
  side_effecting: number;
  idempotency_key: string | null;
  result_ref: string | null;
  spec_json: string;
  created_at: number;
  updated_at: number;
  version: number;
}

interface ClaimRow {
  claim_id: string;
  mission_id: string | null;
  grip_id: string | null;
  resource_type: string;
  resource_key: string;
  owner_arm_id: string;
  mode: string;
  lease_expiry_ts: number;
  created_at: number;
  updated_at: number;
  version: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers — JSON, integer coercion, deserialization
// ──────────────────────────────────────────────────────────────────────────

function nowMs(): number {
  return Date.now();
}

function toSqliteBool(value: boolean): number {
  return value ? 1 : 0;
}

function fromSqliteBool(value: number): boolean {
  return value !== 0;
}

function coerceInt(value: number | bigint | null): number | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "bigint") {
    if (!Number.isSafeInteger(Number(value))) {
      throw new Error(`registry: integer value ${value} exceeds Number.MAX_SAFE_INTEGER`);
    }
    return Number(value);
  }
  return value;
}

function requireInt(value: number | bigint): number {
  const coerced = coerceInt(value);
  if (coerced === null) {
    throw new Error("registry: required integer column was null");
  }
  return coerced;
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (raw === null) {
    return null;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null) {
    return null;
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`registry: expected JSON object in column, got ${typeof parsed}`);
  }
  return parsed as Record<string, unknown>;
}

function serializeJsonRecord(value: Record<string, unknown> | null): string | null {
  return value === null ? null : JSON.stringify(value);
}

// Validate a parsed spec against its TypeBox schema. Throws a descriptive
// error if validation fails — this catches drift between what was stored
// and what the schema currently allows. Used in deserialization paths so
// callers always get a typed, validated record.
function validateStoredSpec<T>(
  schema: Parameters<typeof Value.Check>[0],
  parsed: unknown,
  entity: RegistryEntity,
  id: string,
): T {
  if (!Value.Check(schema, parsed)) {
    const errs = [...Value.Errors(schema, parsed)]
      .map((e) => `${e.path || "<root>"}: ${e.message}`)
      .join("; ");
    throw new Error(`registry: stored ${entity} spec for ${id} failed schema validation: ${errs}`);
  }
  return parsed as T;
}

// ──────────────────────────────────────────────────────────────────────────
// Input shapes for put* — callers supply everything except version and
// (optionally) timestamps. created_at may be provided for replay/tests
// with deterministic timestamps; updated_at is always assigned by the
// service.
// ──────────────────────────────────────────────────────────────────────────

export type MissionInput = Omit<MissionRecord, "version" | "created_at" | "updated_at"> & {
  created_at?: number;
};

export type ArmInput = Omit<ArmRecord, "version" | "created_at" | "updated_at"> & {
  created_at?: number;
};

export type GripInput = Omit<GripRecord, "version" | "created_at" | "updated_at"> & {
  created_at?: number;
};

export type ClaimInput = Omit<ClaimRecord, "version" | "created_at" | "updated_at"> & {
  created_at?: number;
};

// Patch shapes for casUpdate* — every mutable column is optional. The
// primary key, version, and created_at are not patchable.
export type MissionPatch = Partial<Omit<MissionRecord, "mission_id" | "version" | "created_at">>;
export type ArmPatch = Partial<Omit<ArmRecord, "arm_id" | "version" | "created_at">>;
export type GripPatch = Partial<Omit<GripRecord, "grip_id" | "version" | "created_at">>;
export type ClaimPatch = Partial<Omit<ClaimRecord, "claim_id" | "version" | "created_at">>;

// ──────────────────────────────────────────────────────────────────────────
// Filter shapes for list*
// ──────────────────────────────────────────────────────────────────────────

export interface MissionFilter {
  status?: string;
  owner?: string;
  limit?: number;
}

export interface ArmFilter {
  mission_id?: string;
  node_id?: string;
  state?: string;
  agent_id?: string;
  limit?: number;
}

export interface GripFilter {
  mission_id?: string;
  status?: string;
  assigned_arm_id?: string;
  limit?: number;
}

export interface ClaimFilter {
  mission_id?: string;
  resource_type?: string;
  owner_arm_id?: string;
  limit?: number;
}

// ──────────────────────────────────────────────────────────────────────────
// SQLite constraint detection
// ──────────────────────────────────────────────────────────────────────────

function isPrimaryKeyConstraintError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  // node:sqlite surfaces SQLite errors with messages like
  // "UNIQUE constraint failed: arms.arm_id". The exact code field
  // exists on the error in newer Node versions but messages are stable
  // enough for primary-key detection across the supported range.
  const msg = err.message;
  return (
    msg.includes("UNIQUE constraint failed") ||
    msg.includes("PRIMARY KEY") ||
    msg.includes("SQLITE_CONSTRAINT_PRIMARYKEY")
  );
}

// ──────────────────────────────────────────────────────────────────────────
// RegistryService
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_LIST_LIMIT = 1000;

export class RegistryService {
  private readonly stmts: {
    selectMission: StatementSync;
    insertMission: StatementSync;
    selectMissionVersion: StatementSync;

    selectArm: StatementSync;
    insertArm: StatementSync;
    selectArmVersion: StatementSync;

    selectGrip: StatementSync;
    insertGrip: StatementSync;
    selectGripVersion: StatementSync;

    selectClaim: StatementSync;
    insertClaim: StatementSync;
    selectClaimVersion: StatementSync;
  };

  constructor(private readonly db: DatabaseSync) {
    this.stmts = {
      selectMission: db.prepare(`SELECT * FROM missions WHERE mission_id = ?`),
      insertMission: db.prepare(`
        INSERT INTO missions (
          mission_id, title, owner, status, policy_profile_ref,
          spec_json, metadata_json, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `),
      selectMissionVersion: db.prepare(`SELECT version FROM missions WHERE mission_id = ?`),

      selectArm: db.prepare(`SELECT * FROM arms WHERE arm_id = ?`),
      insertArm: db.prepare(`
        INSERT INTO arms (
          arm_id, mission_id, node_id, adapter_type, runtime_name,
          agent_id, task_ref, state, current_grip_id, lease_owner,
          lease_expiry_ts, session_ref_json, checkpoint_ref, health_status,
          restart_count, policy_profile, spec_json, created_at, updated_at,
          version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `),
      selectArmVersion: db.prepare(`SELECT version FROM arms WHERE arm_id = ?`),

      selectGrip: db.prepare(`SELECT * FROM grips WHERE grip_id = ?`),
      insertGrip: db.prepare(`
        INSERT INTO grips (
          grip_id, mission_id, type, input_ref, priority, assigned_arm_id,
          status, timeout_s, side_effecting, idempotency_key, result_ref,
          spec_json, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `),
      selectGripVersion: db.prepare(`SELECT version FROM grips WHERE grip_id = ?`),

      selectClaim: db.prepare(`SELECT * FROM claims WHERE claim_id = ?`),
      insertClaim: db.prepare(`
        INSERT INTO claims (
          claim_id, mission_id, grip_id, resource_type, resource_key,
          owner_arm_id, mode, lease_expiry_ts, created_at, updated_at,
          version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `),
      selectClaimVersion: db.prepare(`SELECT version FROM claims WHERE claim_id = ?`),
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // Missions
  // ════════════════════════════════════════════════════════════════════════

  getMission(mission_id: string): MissionRecord | null {
    const row = this.stmts.selectMission.get(mission_id) as MissionRow | undefined;
    return row ? this.deserializeMission(row) : null;
  }

  putMission(input: MissionInput): MissionRecord {
    const created_at = input.created_at ?? nowMs();
    const updated_at = nowMs();
    try {
      this.stmts.insertMission.run(
        input.mission_id,
        input.title,
        input.owner,
        input.status,
        input.policy_profile_ref,
        JSON.stringify(input.spec),
        serializeJsonRecord(input.metadata),
        created_at,
        updated_at,
      );
    } catch (err) {
      if (isPrimaryKeyConstraintError(err)) {
        throw new DuplicateError("mission", input.mission_id);
      }
      throw err;
    }
    const fetched = this.getMission(input.mission_id);
    if (!fetched) {
      throw new Error(
        `registry: putMission inserted ${input.mission_id} but read-back returned null`,
      );
    }
    return fetched;
  }

  listMissions(filter: MissionFilter = {}): MissionRecord[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.status !== undefined) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    if (filter.owner !== undefined) {
      conditions.push("owner = ?");
      params.push(filter.owner);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit !== undefined ? Number(filter.limit) : DEFAULT_LIST_LIMIT;
    const sql = `SELECT * FROM missions ${where} ORDER BY created_at DESC LIMIT ${limit}`;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as unknown as MissionRow[];
    return rows.map((row) => this.deserializeMission(row));
  }

  casUpdateMission(
    mission_id: string,
    expectedVersion: number,
    patch: MissionPatch,
  ): MissionRecord {
    return this.casUpdate(
      "mission",
      mission_id,
      expectedVersion,
      () => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (patch.title !== undefined) {
          sets.push("title = ?");
          params.push(patch.title);
        }
        if (patch.owner !== undefined) {
          sets.push("owner = ?");
          params.push(patch.owner);
        }
        if (patch.status !== undefined) {
          sets.push("status = ?");
          params.push(patch.status);
        }
        if (patch.policy_profile_ref !== undefined) {
          sets.push("policy_profile_ref = ?");
          params.push(patch.policy_profile_ref);
        }
        if (patch.spec !== undefined) {
          sets.push("spec_json = ?");
          params.push(JSON.stringify(patch.spec));
        }
        if (patch.metadata !== undefined) {
          sets.push("metadata_json = ?");
          params.push(serializeJsonRecord(patch.metadata));
        }
        sets.push("updated_at = ?");
        params.push(nowMs());
        sets.push("version = version + 1");
        const sql = `UPDATE missions SET ${sets.join(", ")} WHERE mission_id = ? AND version = ?`;
        params.push(mission_id, expectedVersion);
        return { sql, params };
      },
      () => {
        const fetched = this.getMission(mission_id);
        if (!fetched) {
          throw new Error(
            `registry: casUpdateMission post-update read-back returned null for ${mission_id}`,
          );
        }
        return fetched;
      },
      this.stmts.selectMissionVersion,
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // Arms
  // ════════════════════════════════════════════════════════════════════════

  getArm(arm_id: string): ArmRecord | null {
    const row = this.stmts.selectArm.get(arm_id) as ArmRow | undefined;
    return row ? this.deserializeArm(row) : null;
  }

  putArm(input: ArmInput): ArmRecord {
    const created_at = input.created_at ?? nowMs();
    const updated_at = nowMs();
    try {
      this.stmts.insertArm.run(
        input.arm_id,
        input.mission_id,
        input.node_id,
        input.adapter_type,
        input.runtime_name,
        input.agent_id,
        input.task_ref,
        input.state,
        input.current_grip_id,
        input.lease_owner,
        input.lease_expiry_ts,
        serializeJsonRecord(input.session_ref),
        input.checkpoint_ref,
        input.health_status,
        input.restart_count,
        input.policy_profile,
        JSON.stringify(input.spec),
        created_at,
        updated_at,
      );
    } catch (err) {
      if (isPrimaryKeyConstraintError(err)) {
        throw new DuplicateError("arm", input.arm_id);
      }
      throw err;
    }
    const fetched = this.getArm(input.arm_id);
    if (!fetched) {
      throw new Error(`registry: putArm inserted ${input.arm_id} but read-back returned null`);
    }
    return fetched;
  }

  listArms(filter: ArmFilter = {}): ArmRecord[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.mission_id !== undefined) {
      conditions.push("mission_id = ?");
      params.push(filter.mission_id);
    }
    if (filter.node_id !== undefined) {
      conditions.push("node_id = ?");
      params.push(filter.node_id);
    }
    if (filter.state !== undefined) {
      conditions.push("state = ?");
      params.push(filter.state);
    }
    if (filter.agent_id !== undefined) {
      conditions.push("agent_id = ?");
      params.push(filter.agent_id);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit !== undefined ? Number(filter.limit) : DEFAULT_LIST_LIMIT;
    const sql = `SELECT * FROM arms ${where} ORDER BY created_at DESC LIMIT ${limit}`;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as unknown as ArmRow[];
    return rows.map((row) => this.deserializeArm(row));
  }

  casUpdateArm(arm_id: string, expectedVersion: number, patch: ArmPatch): ArmRecord {
    return this.casUpdate(
      "arm",
      arm_id,
      expectedVersion,
      () => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (patch.mission_id !== undefined) {
          sets.push("mission_id = ?");
          params.push(patch.mission_id);
        }
        if (patch.node_id !== undefined) {
          sets.push("node_id = ?");
          params.push(patch.node_id);
        }
        if (patch.adapter_type !== undefined) {
          sets.push("adapter_type = ?");
          params.push(patch.adapter_type);
        }
        if (patch.runtime_name !== undefined) {
          sets.push("runtime_name = ?");
          params.push(patch.runtime_name);
        }
        if (patch.agent_id !== undefined) {
          sets.push("agent_id = ?");
          params.push(patch.agent_id);
        }
        if (patch.task_ref !== undefined) {
          sets.push("task_ref = ?");
          params.push(patch.task_ref);
        }
        if (patch.state !== undefined) {
          sets.push("state = ?");
          params.push(patch.state);
        }
        if (patch.current_grip_id !== undefined) {
          sets.push("current_grip_id = ?");
          params.push(patch.current_grip_id);
        }
        if (patch.lease_owner !== undefined) {
          sets.push("lease_owner = ?");
          params.push(patch.lease_owner);
        }
        if (patch.lease_expiry_ts !== undefined) {
          sets.push("lease_expiry_ts = ?");
          params.push(patch.lease_expiry_ts);
        }
        if (patch.session_ref !== undefined) {
          sets.push("session_ref_json = ?");
          params.push(serializeJsonRecord(patch.session_ref));
        }
        if (patch.checkpoint_ref !== undefined) {
          sets.push("checkpoint_ref = ?");
          params.push(patch.checkpoint_ref);
        }
        if (patch.health_status !== undefined) {
          sets.push("health_status = ?");
          params.push(patch.health_status);
        }
        if (patch.restart_count !== undefined) {
          sets.push("restart_count = ?");
          params.push(patch.restart_count);
        }
        if (patch.policy_profile !== undefined) {
          sets.push("policy_profile = ?");
          params.push(patch.policy_profile);
        }
        if (patch.spec !== undefined) {
          sets.push("spec_json = ?");
          params.push(JSON.stringify(patch.spec));
        }
        sets.push("updated_at = ?");
        params.push(nowMs());
        sets.push("version = version + 1");
        const sql = `UPDATE arms SET ${sets.join(", ")} WHERE arm_id = ? AND version = ?`;
        params.push(arm_id, expectedVersion);
        return { sql, params };
      },
      () => {
        const fetched = this.getArm(arm_id);
        if (!fetched) {
          throw new Error(
            `registry: casUpdateArm post-update read-back returned null for ${arm_id}`,
          );
        }
        return fetched;
      },
      this.stmts.selectArmVersion,
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // Grips
  // ════════════════════════════════════════════════════════════════════════

  getGrip(grip_id: string): GripRecord | null {
    const row = this.stmts.selectGrip.get(grip_id) as GripRow | undefined;
    return row ? this.deserializeGrip(row) : null;
  }

  putGrip(input: GripInput): GripRecord {
    const created_at = input.created_at ?? nowMs();
    const updated_at = nowMs();
    try {
      this.stmts.insertGrip.run(
        input.grip_id,
        input.mission_id,
        input.type,
        input.input_ref,
        input.priority,
        input.assigned_arm_id,
        input.status,
        input.timeout_s,
        toSqliteBool(input.side_effecting),
        input.idempotency_key,
        input.result_ref,
        JSON.stringify(input.spec),
        created_at,
        updated_at,
      );
    } catch (err) {
      if (isPrimaryKeyConstraintError(err)) {
        throw new DuplicateError("grip", input.grip_id);
      }
      throw err;
    }
    const fetched = this.getGrip(input.grip_id);
    if (!fetched) {
      throw new Error(`registry: putGrip inserted ${input.grip_id} but read-back returned null`);
    }
    return fetched;
  }

  listGrips(filter: GripFilter = {}): GripRecord[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.mission_id !== undefined) {
      conditions.push("mission_id = ?");
      params.push(filter.mission_id);
    }
    if (filter.status !== undefined) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    if (filter.assigned_arm_id !== undefined) {
      conditions.push("assigned_arm_id = ?");
      params.push(filter.assigned_arm_id);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit !== undefined ? Number(filter.limit) : DEFAULT_LIST_LIMIT;
    const sql = `SELECT * FROM grips ${where} ORDER BY created_at DESC LIMIT ${limit}`;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as unknown as GripRow[];
    return rows.map((row) => this.deserializeGrip(row));
  }

  casUpdateGrip(grip_id: string, expectedVersion: number, patch: GripPatch): GripRecord {
    return this.casUpdate(
      "grip",
      grip_id,
      expectedVersion,
      () => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (patch.mission_id !== undefined) {
          sets.push("mission_id = ?");
          params.push(patch.mission_id);
        }
        if (patch.type !== undefined) {
          sets.push("type = ?");
          params.push(patch.type);
        }
        if (patch.input_ref !== undefined) {
          sets.push("input_ref = ?");
          params.push(patch.input_ref);
        }
        if (patch.priority !== undefined) {
          sets.push("priority = ?");
          params.push(patch.priority);
        }
        if (patch.assigned_arm_id !== undefined) {
          sets.push("assigned_arm_id = ?");
          params.push(patch.assigned_arm_id);
        }
        if (patch.status !== undefined) {
          sets.push("status = ?");
          params.push(patch.status);
        }
        if (patch.timeout_s !== undefined) {
          sets.push("timeout_s = ?");
          params.push(patch.timeout_s);
        }
        if (patch.side_effecting !== undefined) {
          sets.push("side_effecting = ?");
          params.push(toSqliteBool(patch.side_effecting));
        }
        if (patch.idempotency_key !== undefined) {
          sets.push("idempotency_key = ?");
          params.push(patch.idempotency_key);
        }
        if (patch.result_ref !== undefined) {
          sets.push("result_ref = ?");
          params.push(patch.result_ref);
        }
        if (patch.spec !== undefined) {
          sets.push("spec_json = ?");
          params.push(JSON.stringify(patch.spec));
        }
        sets.push("updated_at = ?");
        params.push(nowMs());
        sets.push("version = version + 1");
        const sql = `UPDATE grips SET ${sets.join(", ")} WHERE grip_id = ? AND version = ?`;
        params.push(grip_id, expectedVersion);
        return { sql, params };
      },
      () => {
        const fetched = this.getGrip(grip_id);
        if (!fetched) {
          throw new Error(
            `registry: casUpdateGrip post-update read-back returned null for ${grip_id}`,
          );
        }
        return fetched;
      },
      this.stmts.selectGripVersion,
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // Claims
  // ════════════════════════════════════════════════════════════════════════

  getClaim(claim_id: string): ClaimRecord | null {
    const row = this.stmts.selectClaim.get(claim_id) as ClaimRow | undefined;
    return row ? this.deserializeClaim(row) : null;
  }

  putClaim(input: ClaimInput): ClaimRecord {
    const created_at = input.created_at ?? nowMs();
    const updated_at = nowMs();
    try {
      this.stmts.insertClaim.run(
        input.claim_id,
        input.mission_id,
        input.grip_id,
        input.resource_type,
        input.resource_key,
        input.owner_arm_id,
        input.mode,
        input.lease_expiry_ts,
        created_at,
        updated_at,
      );
    } catch (err) {
      if (isPrimaryKeyConstraintError(err)) {
        throw new DuplicateError("claim", input.claim_id);
      }
      throw err;
    }
    const fetched = this.getClaim(input.claim_id);
    if (!fetched) {
      throw new Error(`registry: putClaim inserted ${input.claim_id} but read-back returned null`);
    }
    return fetched;
  }

  listClaims(filter: ClaimFilter = {}): ClaimRecord[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.mission_id !== undefined) {
      conditions.push("mission_id = ?");
      params.push(filter.mission_id);
    }
    if (filter.resource_type !== undefined) {
      conditions.push("resource_type = ?");
      params.push(filter.resource_type);
    }
    if (filter.owner_arm_id !== undefined) {
      conditions.push("owner_arm_id = ?");
      params.push(filter.owner_arm_id);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit !== undefined ? Number(filter.limit) : DEFAULT_LIST_LIMIT;
    const sql = `SELECT * FROM claims ${where} ORDER BY created_at DESC LIMIT ${limit}`;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as unknown as ClaimRow[];
    return rows.map((row) => this.deserializeClaim(row));
  }

  casUpdateClaim(claim_id: string, expectedVersion: number, patch: ClaimPatch): ClaimRecord {
    return this.casUpdate(
      "claim",
      claim_id,
      expectedVersion,
      () => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (patch.mission_id !== undefined) {
          sets.push("mission_id = ?");
          params.push(patch.mission_id);
        }
        if (patch.grip_id !== undefined) {
          sets.push("grip_id = ?");
          params.push(patch.grip_id);
        }
        if (patch.resource_type !== undefined) {
          sets.push("resource_type = ?");
          params.push(patch.resource_type);
        }
        if (patch.resource_key !== undefined) {
          sets.push("resource_key = ?");
          params.push(patch.resource_key);
        }
        if (patch.owner_arm_id !== undefined) {
          sets.push("owner_arm_id = ?");
          params.push(patch.owner_arm_id);
        }
        if (patch.mode !== undefined) {
          sets.push("mode = ?");
          params.push(patch.mode);
        }
        if (patch.lease_expiry_ts !== undefined) {
          sets.push("lease_expiry_ts = ?");
          params.push(patch.lease_expiry_ts);
        }
        sets.push("updated_at = ?");
        params.push(nowMs());
        sets.push("version = version + 1");
        const sql = `UPDATE claims SET ${sets.join(", ")} WHERE claim_id = ? AND version = ?`;
        params.push(claim_id, expectedVersion);
        return { sql, params };
      },
      () => {
        const fetched = this.getClaim(claim_id);
        if (!fetched) {
          throw new Error(
            `registry: casUpdateClaim post-update read-back returned null for ${claim_id}`,
          );
        }
        return fetched;
      },
      this.stmts.selectClaimVersion,
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // Internal: shared CAS update primitive
  //
  // Wraps the UPDATE + version-check + read-back in a SQLite transaction
  // so concurrent writers serialize through SQLite's locking instead of
  // racing on stale rows. The order is:
  //   1. BEGIN IMMEDIATE — take the write lock up front
  //   2. UPDATE ... WHERE id = ? AND version = ?
  //   3. If changes === 0:
  //        a. SELECT version to distinguish "row missing" from
  //           "version mismatch"
  //        b. ROLLBACK and throw ConflictError with the right shape
  //   4. Otherwise COMMIT and return the read-back record
  //
  // Errors during the transaction body always trigger a ROLLBACK before
  // re-throwing so the DB never leaks an open transaction.
  // ════════════════════════════════════════════════════════════════════════

  private casUpdate<T>(
    entity: RegistryEntity,
    id: string,
    expectedVersion: number,
    buildUpdate: () => { sql: string; params: unknown[] },
    readBack: () => T,
    selectVersion: StatementSync,
  ): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { sql, params } = buildUpdate();
      const stmt = this.db.prepare(sql);
      const result = stmt.run(...(params as never[]));
      const changes = typeof result.changes === "bigint" ? Number(result.changes) : result.changes;
      if (changes === 0) {
        const versionRow = selectVersion.get(id) as { version: number | bigint } | undefined;
        let actualVersion: number | null;
        if (versionRow === undefined) {
          actualVersion = null;
        } else {
          actualVersion = requireInt(versionRow.version);
        }
        this.db.exec("ROLLBACK");
        throw new ConflictError(entity, id, expectedVersion, actualVersion);
      }
      const record = readBack();
      this.db.exec("COMMIT");
      return record;
    } catch (err) {
      // If we're already past ROLLBACK (the ConflictError path), exec
      // will fail with "no transaction is active" — swallow that one
      // case so the original error propagates cleanly.
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back or never started
      }
      throw err;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Internal: row -> record deserialization
  // ════════════════════════════════════════════════════════════════════════

  private deserializeMission(row: MissionRow): MissionRecord {
    const parsedSpec = JSON.parse(row.spec_json) as unknown;
    const spec = validateStoredSpec<MissionSpec>(
      MissionSpecSchema,
      parsedSpec,
      "mission",
      row.mission_id,
    );
    return {
      mission_id: row.mission_id,
      title: row.title,
      owner: row.owner,
      status: row.status,
      policy_profile_ref: row.policy_profile_ref,
      spec,
      metadata: parseJsonRecord(row.metadata_json),
      created_at: requireInt(row.created_at),
      updated_at: requireInt(row.updated_at),
      version: requireInt(row.version),
    };
  }

  private deserializeArm(row: ArmRow): ArmRecord {
    const parsedSpec = JSON.parse(row.spec_json) as unknown;
    const spec = validateStoredSpec<ArmSpec>(ArmSpecSchema, parsedSpec, "arm", row.arm_id);
    return {
      arm_id: row.arm_id,
      mission_id: row.mission_id,
      node_id: row.node_id,
      adapter_type: row.adapter_type,
      runtime_name: row.runtime_name,
      agent_id: row.agent_id,
      task_ref: row.task_ref,
      state: row.state,
      current_grip_id: row.current_grip_id,
      lease_owner: row.lease_owner,
      lease_expiry_ts: coerceInt(row.lease_expiry_ts),
      session_ref: parseJsonRecord(row.session_ref_json),
      checkpoint_ref: row.checkpoint_ref,
      health_status: row.health_status,
      restart_count: requireInt(row.restart_count),
      policy_profile: row.policy_profile,
      spec,
      created_at: requireInt(row.created_at),
      updated_at: requireInt(row.updated_at),
      version: requireInt(row.version),
    };
  }

  private deserializeGrip(row: GripRow): GripRecord {
    const parsedSpec = JSON.parse(row.spec_json) as unknown;
    const spec = validateStoredSpec<GripSpec>(GripSpecSchema, parsedSpec, "grip", row.grip_id);
    return {
      grip_id: row.grip_id,
      mission_id: row.mission_id,
      type: row.type,
      input_ref: row.input_ref,
      priority: requireInt(row.priority),
      assigned_arm_id: row.assigned_arm_id,
      status: row.status,
      timeout_s: coerceInt(row.timeout_s),
      side_effecting: fromSqliteBool(row.side_effecting),
      idempotency_key: row.idempotency_key,
      result_ref: row.result_ref,
      spec,
      created_at: requireInt(row.created_at),
      updated_at: requireInt(row.updated_at),
      version: requireInt(row.version),
    };
  }

  private deserializeClaim(row: ClaimRow): ClaimRecord {
    const mode = row.mode;
    if (mode !== "exclusive" && mode !== "shared-read") {
      throw new Error(`registry: stored claim ${row.claim_id} has invalid mode ${mode}`);
    }
    return {
      claim_id: row.claim_id,
      mission_id: row.mission_id,
      grip_id: row.grip_id,
      resource_type: row.resource_type,
      resource_key: row.resource_key,
      owner_arm_id: row.owner_arm_id,
      mode,
      lease_expiry_ts: requireInt(row.lease_expiry_ts),
      created_at: requireInt(row.created_at),
      updated_at: requireInt(row.updated_at),
      version: requireInt(row.version),
    };
  }
}
