import { isRecord } from "@openclaw/normalization-core/record-coerce";

// v39 retains cold transcript navigation while payloads remain in their verified archives.
// v38 splits punctuation-joined PostgreSQL full-text tokens like SQLite FTS5.
// v37 stores cold transcript windows in ordered, independently bounded archive chunks.
// v36 indexes PostgreSQL memory exact-path candidates without changing ranking.
// v35 extends native PostgreSQL index ordering to predicate-proven non-null keys.
// v34 aligns non-null PostgreSQL index keys with default query ordering.
// v33 adds a stored PostgreSQL binary vector candidate projection.
// v32 replaces the PostgreSQL vector decoder without rewriting canonical rows.
export const OPENCLAW_AGENT_SCHEMA_VERSION = 39;

// v39 retains worker policy and uncertain pause/resume operations across restart.
// v38 retains repository disk authority and the original authority of pending results.
// v37 retains immutable provider resource identity through environment teardown.
// v36 migrates released starter tables and provenance to canonical Template names.
// v35 replaces per-worktree workspace nodes with shared immutable trees and scan fingerprints.
// v34 binds the default cron partition independently of the state directory.
// v33 extends native PostgreSQL index ordering to predicate-proven non-null keys.
// v32 aligns non-null PostgreSQL index keys with default query ordering.
// v31 stores local workspace baselines by path and checkpoints as recoverable deltas.
// v30 fences ordinary automation timing and delivery policies from older schedulers.
// v29 moves client credentials and native socket material to the local credential owner.
// v28 retains the requested GitHub PR draft choice across recovery.
// v27 removes unused replay/skill indexes and narrows the lease-owner index.
// v26 stores session state heads directly in their composite primary-key tree.
// v25 prevents older readers from dropping recovered subagent operator restrictions.
// v24 replaces retained task indexes with ordered cron history indexes.
// v23 persists normalized meeting transcript chronology.
// v22 promotes ACP resume keys and explicit portable cursor identities.
// v21 derives meeting transcript selectors and bounded delivery retention columns.
// v20 fences possibly delivered cron completions across restart recovery.
// v19 preserves original channel-owner authorization across recovery.
// v18 binds shared GitHub publication to its original requesting authority.
// v17 records one-use prepared worker capacity and node workspace ownership.
// v16 makes Skill Workshop ownership directory-based instead of row-provenance-based.
// v15 removes redundant agent/session projections from conversation bindings.
// v14 retains unknown creator namespaces on historical cron jobs.
// v13 keeps cron jobs and subagent runs canonical in JSON, removing unused projections.
// v12 folds singleton state into config_machine_state and retires write-only cron epochs.
// v11 retires the legacy skill curator lifecycle and write-only proposal origin runs.
// v10 retires six dead tables that shipped without runtime owners.
// v9 stores in-root agent database registry paths relative to the state dir.
// v8 records cloud-placement execution mode and mode-aware turn claims.
// v7 retires the inert shared commitments table.
// v6 makes every committed shared-state table part of the canonical runtime schema.
// v5 records durable cloud-worker result refs on pending workspace fences.
export const OPENCLAW_STATE_SCHEMA_VERSION = 39;

export type OpenClawSchemaVersions = {
  state: number;
  agent: number;
};

export function parseOpenClawSchemaVersions(value: unknown): OpenClawSchemaVersions | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { state, agent } = value;
  if (
    typeof state !== "number" ||
    !Number.isInteger(state) ||
    state < 0 ||
    typeof agent !== "number" ||
    !Number.isInteger(agent) ||
    agent < 0
  ) {
    return undefined;
  }
  return { state, agent };
}

export function parsePackageOpenClawSchemaVersions(
  packageJson: unknown,
): OpenClawSchemaVersions | undefined {
  if (!isRecord(packageJson)) {
    return undefined;
  }
  const openclaw = packageJson.openclaw;
  if (openclaw !== undefined) {
    if (!isRecord(openclaw)) {
      return undefined;
    }
    const schemaVersions = openclaw.schemaVersions;
    if (schemaVersions !== undefined) {
      return parseOpenClawSchemaVersions(schemaVersions);
    }
  }
  // Published OpenClaw stable releases through 2026.7.1 used schema 1 before
  // declaring it in package metadata. Unknown versions and replacement packages
  // cannot inherit that shipped contract. See database-schemas/integrity-and-recovery.
  if (packageJson.name !== "openclaw" || typeof packageJson.version !== "string") {
    return undefined;
  }
  const legacy = /^2026\.([1-7])\.([1-9]\d*)$/.exec(packageJson.version);
  if (
    !legacy ||
    !Number.isSafeInteger(Number(legacy[2])) ||
    (legacy[1] === "7" && legacy[2] !== "1")
  ) {
    return undefined;
  }
  return { state: 1, agent: 1 };
}
