// Octopus Orchestrator — EventLog schema-version migration framework (M1-05)
//
// Context docs:
//   - LLD §Event Schema Versioning and Migration — migration discipline
//   - DECISIONS.md OCTO-DEC-018 — additive-vs-breaking change discipline
//   - DECISIONS.md OCTO-DEC-033 — boundary discipline
//
// Purpose:
//   Owns the canonical migration registry consumed by EventLogService.replay
//   (M1-04). Replay walks historical events through this registry to upgrade
//   them to the current canonical schema_version before handing them to the
//   in-memory projection.
//
// Discipline (OCTO-DEC-018 + LLD §Event Schema Versioning and Migration):
//   - schema_version starts at 1. It is bumped ONLY on breaking payload
//     changes (field removal, type change, semantic change, envelope
//     restructuring). Additive changes (new event_type, new entity_type,
//     new optional payload field) do NOT bump schema_version.
//   - Every registered migration MUST be pure and total. It MUST NOT throw
//     on any historical on-disk input. If a field is missing or malformed
//     in a historical event, the migration produces a sensible default or
//     fallback — it never crashes. The replay loop trusts migrations to
//     never fail on real data.
//   - Migrations bump schema_version by exactly one. `migrations[N]` takes
//     an envelope at version N and returns one at version N+1. A migration
//     that forgets to bump, or that bumps by more than one, is a bug; the
//     walking helper below detects it and fails loud.
//   - If a breaking change cannot be losslessly migrated, a new event type
//     is introduced instead and the old events are preserved verbatim
//     (LLD §Event Schema Versioning rule 3).
//
// Why the registry ships empty:
//   OCTO-DEC-018 + the LLD's additive discipline mean schema_version stays
//   at 1 until a breaking change is introduced. M1 has no breaking changes,
//   so the registry is empty by design. The framework exists so that the
//   first breaking change is a one-line registration + bump of
//   CURRENT_EVENT_SCHEMA_VERSION. The empty baseline is exhaustively tested.
//
// Forward compatibility:
//   Envelopes with `schema_version > CURRENT_EVENT_SCHEMA_VERSION` pass
//   through unchanged. This covers the downgrade scenario (a newer binary
//   wrote events, then the deployment rolled back). The migration loop
//   condition is `< current`, not `!= current`, deliberately. Do not
//   tighten this without understanding the forward-compat guarantee.
//
// Boundary discipline (OCTO-DEC-033):
//   Only `node:*` builtins, `@sinclair/typebox`, and relative imports
//   inside `src/octo/` are permitted here. This module has no runtime
//   dependencies beyond the EventEnvelope type.

import type { EventEnvelope } from "../wire/events.ts";
// ══════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════
/**
 * MigrationFn — upgrades a single event envelope one schema version
 * forward (v_N → v_{N+1}). The returned envelope MUST have
 * `schema_version` set to exactly `envelope.schema_version + 1`.
 *
 * Contract:
 *   - Pure: no side effects, no I/O, no mutation of the input.
 *   - Total: never throws on any historical input. Missing or malformed
 *     fields must be handled with defaults or fallbacks, not exceptions.
 *   - Bumps schema_version by exactly one.
 *
 * This is the same shape as the `MigrationFn` re-exported from
 * `./event-log.ts` (M1-04); we re-export that canonical type here rather
 * than redeclare it so there is a single source of truth.
 */
import type { MigrationFn } from "./event-log.ts";
export type { MigrationFn };

// ══════════════════════════════════════════════════════════════════════════
// Canonical registry + current version
// ══════════════════════════════════════════════════════════════════════════

/**
 * The current canonical event schema version. Every new append from the
 * Head writes events at this version. Replay upgrades historical events
 * with a lower version to this version via the registry below.
 *
 * Bump this ONLY when landing a breaking change AND simultaneously
 * registering a migration from the prior version in EVENT_LOG_MIGRATIONS.
 * Bumping without a matching migration is a configuration error — the
 * replay loop will throw on any historical event at the prior version.
 */
export const CURRENT_EVENT_SCHEMA_VERSION = 1;

/**
 * Canonical migration registry. Keyed by SOURCE version:
 * `EVENT_LOG_MIGRATIONS[N]` upgrades a v_N envelope to a v_{N+1} envelope.
 *
 * M1-05 ships an empty registry because no breaking changes have been
 * made yet — version 1 is the baseline. The first breaking change will
 * register `EVENT_LOG_MIGRATIONS[1]` and bump
 * `CURRENT_EVENT_SCHEMA_VERSION` to 2.
 *
 * Frozen via Object.freeze and typed `Readonly` so callers cannot mutate
 * the registry at runtime. Any attempt to write a property throws in
 * strict mode.
 */
export const EVENT_LOG_MIGRATIONS: Readonly<Record<number, MigrationFn>> = Object.freeze(
  {} as Record<number, MigrationFn>,
);

// ══════════════════════════════════════════════════════════════════════════
// Migration helpers
// ══════════════════════════════════════════════════════════════════════════

/**
 * Upgrade an envelope to a specific target version using a caller-supplied
 * registry. This is the lower-level helper that powers `migrateToCurrent`
 * and is exposed for testability (so tests can exercise the walking logic
 * with mock registries and mock targets without monkey-patching the
 * module-level constants).
 *
 * Semantics:
 *   - If `envelope.schema_version >= targetVersion`, the envelope is
 *     returned unchanged. This covers both the "already at target" and
 *     the "forward-compatibility / downgrade" cases.
 *   - Otherwise the walker repeatedly looks up `registry[current.schema_version]`,
 *     applies it, and continues until the envelope reaches the target.
 *   - Throws on a missing migration in the chain (configuration error:
 *     some migration was never written).
 *   - Throws on a non-bumping migration (defensive: a well-meaning future
 *     contributor could write a migration that forgets to bump, causing
 *     an infinite loop; fail loud on the first call instead).
 *   - Throws on a migration that bumps by more than one (migrations must
 *     walk one version at a time; M1-04's replay loop has the same
 *     invariant).
 */
export function migrateEnvelope(
  envelope: EventEnvelope,
  targetVersion: number,
  registry: Readonly<Record<number, MigrationFn>>,
): EventEnvelope {
  if (envelope.schema_version >= targetVersion) {
    return envelope;
  }

  let current = envelope;
  while (current.schema_version < targetVersion) {
    const from = current.schema_version;
    const migrate = registry[from];
    if (!migrate) {
      throw new Error(
        `event-log-migrations: no migration registered for schema_version ${from} -> ${from + 1} (target ${targetVersion})`,
      );
    }
    const next = migrate(current);
    if (next.schema_version !== from + 1) {
      throw new Error(
        `event-log-migrations: migration from schema_version ${from} produced schema_version ${next.schema_version}, expected ${from + 1}`,
      );
    }
    current = next;
  }
  return current;
}

/**
 * Upgrade an envelope to `CURRENT_EVENT_SCHEMA_VERSION` using the
 * canonical `EVENT_LOG_MIGRATIONS` registry. Thin wrapper around
 * `migrateEnvelope`. Use this anywhere a historical envelope needs to
 * be normalized in isolation (outside of the replay loop, which does
 * its own walking).
 *
 * Forward compatibility: envelopes at a version higher than
 * `CURRENT_EVENT_SCHEMA_VERSION` pass through unchanged.
 */
export function migrateToCurrent(envelope: EventEnvelope): EventEnvelope {
  return migrateEnvelope(envelope, CURRENT_EVENT_SCHEMA_VERSION, EVENT_LOG_MIGRATIONS);
}

// ══════════════════════════════════════════════════════════════════════════
// Replay wiring convenience
// ══════════════════════════════════════════════════════════════════════════

/**
 * Convenience helper that returns the canonical replay options — the
 * full migration registry plus the current schema version — so callers
 * of `EventLogService.replay()` can wire up versioning in a single call:
 *
 *   await eventLog.replay(handler, eventLogReplayDefaults());
 *
 * Downstream modules (M1-13 SessionReconciler, M1-14 spawn handler
 * failure-recovery scenarios, etc.) should use this helper rather than
 * re-importing both constants independently.
 */
export function eventLogReplayDefaults(): {
  migrations: Readonly<Record<number, MigrationFn>>;
  currentSchemaVersion: number;
} {
  return {
    migrations: EVENT_LOG_MIGRATIONS,
    currentSchemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
  };
}
