-- Octopus Orchestrator — Registry SQLite schema (M1-01)
--
-- Scope: this file defines the SQLite registry schema for the Octopus Head.
-- It is the structural bootstrap consumed by migrate.ts, and the schema the
-- M1-02 RegistryService will read and CAS-update.
--
-- Context:
--   - LLD §Core Domain Objects — canonical field lists for MissionRecord,
--     ArmRecord, GripRecord, ClaimRecord, ArtifactRecord
--   - LLD §Storage Choices — SQLite for MVP, path ~/.openclaw/octo/registry.sqlite,
--     CAS semantics via a monotonic `version` column
--   - DECISIONS.md OCTO-DEC-010 — SQLite for MVP storage
--   - DECISIONS.md OCTO-DEC-033 — no OpenClaw internal imports outside the
--     adapters/openclaw bridge layer (note: this is a .sql file and the
--     boundary check only parses .ts files, but the discipline still holds
--     for the accompanying migrate.ts)
--
-- Design decisions encoded here:
--
-- 1. ULID primary keys (TEXT). All entity primary keys are ULID strings, not
--    autoincrement integers. ULIDs are monotonic, sortable, globally unique,
--    and match the event log's event_id shape (LLD §Event Schema). This
--    keeps the registry coherent with the append-only event stream, which is
--    the source of truth for rebuild-from-replay.
--
-- 2. No foreign key constraints. Cross-table references (mission_id on arms,
--    grip_id on claims, etc.) are plain TEXT columns with indices — not
--    `REFERENCES` constraints. Rationale: the registry is a cache rebuilt
--    from the event log (see LLD §Recovery Flows and M1-04), and FK
--    enforcement would fight partial replay, out-of-order event application,
--    and archival pruning. Indices give us the lookup performance we need
--    without coupling row lifetimes.
--
-- 3. `version INTEGER NOT NULL DEFAULT 0` on every mutable table. This is
--    the CAS token described in LLD §Storage Choices and OCTO-DEC-010:
--    RegistryService performs `UPDATE ... WHERE version = :expected` and
--    throws ConflictError if no rows match. Monotonic integer is sufficient
--    under the single-writer control-plane assumption (one Gateway process
--    in the MVP).
--
-- 4. Artifacts have no `version` column. Artifacts are immutable once
--    written (LLD §Core Domain Objects — ArtifactRecord only has created_ts,
--    no updated_ts, and the lifecycle is create-then-read-forever). A CAS
--    token on an immutable row would be dead weight. This is intentional
--    and is asserted by a dedicated test in migrate.test.ts.
--
-- 5. Timestamps are unix millis (INTEGER), not ISO strings. Consistent with
--    src/tasks/task-registry.store.sqlite.ts and friendly to range queries.
--    Note: the event log separately uses ISO 8601 per LLD §Event Schema —
--    the registry is a projection and does not need to preserve that format.
--
-- 6. JSON-shaped fields are stored as TEXT with a `_json` suffix
--    (`spec_json`, `metadata_json`, `labels_json`, `session_ref_json`, etc.).
--    They are parsed and TypeBox-validated at the service layer. Rationale:
--    the ArmSpec / GripSpec / MissionSpec shapes will evolve across
--    Milestones 1–5, and extracting every field into its own column would
--    force a migration per schema bump. Storing the spec verbatim as JSON
--    lets additive evolution happen without DDL churn. We still extract the
--    few columns the scheduler and operator CLI filter by (mission_id,
--    status, adapter_type, state, etc.) into typed columns for indexing.
--
-- 7. Enum-like fields (`status`, `state`, `mode`, etc.) are TEXT without
--    SQLite CHECK constraints. Validation is enforced by TypeBox at the
--    service layer (src/octo/wire/schema.ts). Baking the enum set into SQL
--    would force a migration every time an enum member is added — and the
--    arm state enum in particular is still evolving through Milestone 3.
--
-- 8. Leases live in their own table, keyed by arm_id. LLD ArmRecord carries
--    `lease_owner` and `lease_expiry_ts` inline, and LLD §Storage Choices
--    lists a "lease index" as a distinct persisted structure. We materialize
--    that index as a separate `leases` table (1:1 with arms when an arm
--    holds a lease, 0:1 when it does not) so the scheduler can query the
--    set of live leases without scanning the full arms table and so that
--    M1-02's RegistryService can renew/expire leases independently of the
--    arm row's version. The inline arm fields remain authoritative for
--    recovery (the arm row is what replay rebuilds), and the leases table
--    is rebuilt as a projection on top of it. The `arms` table therefore
--    also keeps `lease_owner` and `lease_expiry_ts` columns for parity with
--    the LLD ArmRecord field list.

-- -----------------------------------------------------------------------------
-- missions
-- -----------------------------------------------------------------------------
-- LLD §Core Domain Objects — MissionRecord
-- Fields: mission_id, title, owner, status, grip_ids[], arm_ids[],
-- policy_profile_ref, created_ts, updated_ts, metadata.
-- grip_ids/arm_ids are derivable by querying arms/grips WHERE mission_id=?,
-- so they are not stored as duplicated columns.
CREATE TABLE IF NOT EXISTS missions (
  mission_id          TEXT PRIMARY KEY NOT NULL,
  title               TEXT NOT NULL,
  owner               TEXT NOT NULL,
  status              TEXT NOT NULL,
  policy_profile_ref  TEXT,
  spec_json           TEXT NOT NULL,
  metadata_json       TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  version             INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);
CREATE INDEX IF NOT EXISTS idx_missions_owner  ON missions(owner);

-- -----------------------------------------------------------------------------
-- arms
-- -----------------------------------------------------------------------------
-- LLD §Core Domain Objects — ArmRecord
-- Fields: arm_id, mission_id, node_id, adapter_type, runtime_name, agent_id,
-- task_ref, state, current_grip_id, lease_owner, lease_expiry_ts, session_ref,
-- checkpoint_ref, health_status, restart_count, policy_profile,
-- created_ts, updated_ts.
CREATE TABLE IF NOT EXISTS arms (
  arm_id              TEXT PRIMARY KEY NOT NULL,
  mission_id          TEXT NOT NULL,
  node_id             TEXT NOT NULL,
  adapter_type        TEXT NOT NULL,
  runtime_name        TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  task_ref            TEXT,
  state               TEXT NOT NULL,
  current_grip_id     TEXT,
  lease_owner         TEXT,
  lease_expiry_ts     INTEGER,
  session_ref_json    TEXT,
  checkpoint_ref      TEXT,
  health_status       TEXT,
  restart_count       INTEGER NOT NULL DEFAULT 0,
  policy_profile      TEXT,
  spec_json           TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  version             INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_arms_mission_id       ON arms(mission_id);
CREATE INDEX IF NOT EXISTS idx_arms_node_id          ON arms(node_id);
CREATE INDEX IF NOT EXISTS idx_arms_state            ON arms(state);
CREATE INDEX IF NOT EXISTS idx_arms_current_grip_id  ON arms(current_grip_id);
CREATE INDEX IF NOT EXISTS idx_arms_agent_id         ON arms(agent_id);
CREATE INDEX IF NOT EXISTS idx_arms_lease_expiry_ts  ON arms(lease_expiry_ts);

-- -----------------------------------------------------------------------------
-- grips
-- -----------------------------------------------------------------------------
-- LLD §Core Domain Objects — GripRecord
-- Fields: grip_id, mission_id, type, input_ref, desired_capabilities,
-- priority, assigned_arm_id, status, retry_policy, timeout_s, claim_set,
-- result_ref, side_effecting, idempotency_key.
CREATE TABLE IF NOT EXISTS grips (
  grip_id              TEXT PRIMARY KEY NOT NULL,
  mission_id           TEXT NOT NULL,
  type                 TEXT NOT NULL,
  input_ref            TEXT,
  priority             INTEGER NOT NULL DEFAULT 0,
  assigned_arm_id      TEXT,
  status               TEXT NOT NULL,
  timeout_s            INTEGER,
  side_effecting       INTEGER NOT NULL DEFAULT 0,
  idempotency_key      TEXT,
  result_ref           TEXT,
  spec_json            TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  version              INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_grips_mission_id       ON grips(mission_id);
CREATE INDEX IF NOT EXISTS idx_grips_status           ON grips(status);
CREATE INDEX IF NOT EXISTS idx_grips_assigned_arm_id  ON grips(assigned_arm_id);
CREATE INDEX IF NOT EXISTS idx_grips_priority         ON grips(priority);
CREATE INDEX IF NOT EXISTS idx_grips_idempotency_key  ON grips(idempotency_key);

-- -----------------------------------------------------------------------------
-- claims
-- -----------------------------------------------------------------------------
-- LLD §Core Domain Objects — ClaimRecord
-- Fields: claim_id, resource_type, resource_key, owner_arm_id, mode,
-- lease_expiry_ts.
-- Additional columns: mission_id and grip_id are included to match the
-- M1-01 task spec column list and to let operators filter claims by mission
-- in the CLI (both are derivable from owner_arm_id, but materializing them
-- avoids the extra join on every status query and is cheap to set at
-- claim-creation time).
CREATE TABLE IF NOT EXISTS claims (
  claim_id          TEXT PRIMARY KEY NOT NULL,
  mission_id        TEXT,
  grip_id           TEXT,
  resource_type     TEXT NOT NULL,
  resource_key      TEXT NOT NULL,
  owner_arm_id      TEXT NOT NULL,
  mode              TEXT NOT NULL,
  lease_expiry_ts   INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  version           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_claims_mission_id      ON claims(mission_id);
CREATE INDEX IF NOT EXISTS idx_claims_grip_id         ON claims(grip_id);
CREATE INDEX IF NOT EXISTS idx_claims_owner_arm_id    ON claims(owner_arm_id);
CREATE INDEX IF NOT EXISTS idx_claims_resource        ON claims(resource_type, resource_key);
CREATE INDEX IF NOT EXISTS idx_claims_lease_expiry_ts ON claims(lease_expiry_ts);

-- -----------------------------------------------------------------------------
-- leases
-- -----------------------------------------------------------------------------
-- Projection of live arm leases for fast scheduler lookup. LLD §Storage
-- Choices names a "lease index" distinct from the inline arm lease fields.
-- Keyed by arm_id because an arm holds at most one lease at a time.
CREATE TABLE IF NOT EXISTS leases (
  arm_id        TEXT PRIMARY KEY NOT NULL,
  node_id       TEXT NOT NULL,
  lease_owner   TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  renewed_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  version       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_leases_node_id     ON leases(node_id);
CREATE INDEX IF NOT EXISTS idx_leases_expires_at  ON leases(expires_at);

-- -----------------------------------------------------------------------------
-- artifacts (IMMUTABLE — no `version` column)
-- -----------------------------------------------------------------------------
-- LLD §Core Domain Objects — ArtifactRecord
-- Fields: artifact_id, artifact_type, mission_id, arm_id, storage_ref,
-- metadata, created_ts.
-- Artifacts are write-once. There is no update path, so there is no CAS
-- token. This is intentional — see header note 4 above. grip_id is included
-- as an optional association because many artifacts are scoped to a specific
-- grip rather than to an arm or mission alone.
CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id     TEXT PRIMARY KEY NOT NULL,
  artifact_type   TEXT NOT NULL,
  mission_id      TEXT,
  grip_id         TEXT,
  arm_id          TEXT,
  storage_ref     TEXT NOT NULL,
  metadata_json   TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_mission_id    ON artifacts(mission_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_grip_id       ON artifacts(grip_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_arm_id        ON artifacts(arm_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_artifact_type ON artifacts(artifact_type);
