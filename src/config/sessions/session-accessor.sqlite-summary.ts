import {
  executeSqliteQuerySync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import type {
  SessionAccessScope,
  SessionEntrySummary,
} from "./session-accessor.sqlite-contract.js";
import { projectSqliteSessionParticipantsBatch } from "./session-accessor.sqlite-participant-projection.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  canonicalSessionKeyMigrationRequiredError,
} from "./session-canonical-key.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";

type SummaryCandidate = {
  sessionKey: string;
  entryValid: number | null;
  agent?: SessionStoreSummary;
};

type SessionStoreSummary = { count: number; recent: SessionEntrySummary[] };

/** Reads counts and bounded recent session payloads without warming the store cache. */
export function readSessionStoreSummaryReadOnly(
  scope: Pick<SessionAccessScope, "agentId" | "defaultAgentId" | "env" | "storePath">,
  options: {
    recentLimit: number;
    agentIds: readonly string[];
  },
): SessionStoreSummary & { byAgent: Map<string, SessionStoreSummary> } {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const summary: SessionStoreSummary & { byAgent: Map<string, SessionStoreSummary> } = {
    count: 0,
    recent: [],
    byAgent: new Map<string, SessionStoreSummary>(
      options.agentIds.map((agentId) => [agentId, { count: 0, recent: [] }]),
    ),
  };
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(database.db, () => {
        assertCanonicalSqliteSessionKeysCurrent(database);
        const db = getSessionKysely(database.db);
        // The read transaction keeps count, ordering, and selected payloads on one
        // generation. Existing keys/indexes bound JSON work, not the cold canonical check.
        // Small stores keep their bounded recent payloads; shared stores amortize
        // hydration without retaining every pending row or assuming entry_valid can parse.
        const batchSize = Math.min(
          128,
          Math.max(1, Math.ceil(options.recentLimit) || 1) * Math.max(1, summary.byAgent.size),
        );
        let candidates: SummaryCandidate[] = [];
        const readCandidates = () => {
          if (candidates.length === 0) {
            return;
          }
          const rows = candidates;
          candidates = [];
          const storedRows = new Map(
            executeSqliteQuerySync(
              database.db,
              db
                .selectFrom("session_nodes")
                .selectAll()
                .where("session_key", "in", sqliteStringSet(rows.map((row) => row.sessionKey))),
            ).rows.map((row) => [row.session_key, row]),
          );
          const selectedEntries: SessionEntrySummary[] = [];
          for (const { sessionKey, entryValid, agent } of rows) {
            const needsRecent =
              summary.recent.length < options.recentLimit ||
              (agent !== undefined && agent.recent.length < options.recentLimit);
            if (entryValid === 1 && !needsRecent) {
              summary.count += 1;
              if (agent) {
                agent.count += 1;
              }
              continue;
            }
            // Raw updates clear entry_valid. Preserve listing's warm-row semantics:
            // skip unreadable JSON/retained placeholders, but include readable pending rows.
            const stored = storedRows.get(sessionKey);
            if (!stored) {
              continue;
            }
            const { current_session_id: _currentSessionId, ...listRow } = stored;
            const entry = parseSessionEntryJson(listRow);
            if (!entry) {
              continue;
            }
            summary.count += 1;
            const selected = { sessionKey, entry };
            selectedEntries.push(selected);
            if (summary.recent.length < options.recentLimit) {
              summary.recent.push(selected);
            }
            if (agent) {
              agent.count += 1;
              // The global newest rows may all belong to another agent. Select each
              // requested owner's window in this scan, sharing each parsed payload.
              if (agent.recent.length < options.recentLimit) {
                agent.recent.push(selected);
              }
            }
          }
          if (selectedEntries.length === 0) {
            return;
          }
          const projected = projectSqliteSessionParticipantsBatch(
            database.db,
            new Map(selectedEntries.map(({ sessionKey, entry }) => [sessionKey, entry])),
          );
          for (const { sessionKey, entry } of selectedEntries) {
            Object.assign(entry, projected.get(sessionKey));
            const deliveryCanonicalKey = resolveDeliveryProvenCanonicalSessionKey(
              sessionKey,
              entry,
            );
            if (deliveryCanonicalKey !== sessionKey) {
              throw canonicalSessionKeyMigrationRequiredError(
                `non-canonical persisted row resolves to session key ${deliveryCanonicalKey}`,
              );
            }
          }
        };
        for (const row of iterateSqliteQuerySync(
          database.db,
          db
            .selectFrom("session_nodes")
            .select(["session_key", "entry_valid"])
            .orderBy("updated_at", "desc")
            .orderBy("session_key", "asc"),
        )) {
          const owner = parseAgentSessionKey(row.session_key)?.agentId;
          if (!owner || isInternalSessionEffectsKey(row.session_key)) {
            continue;
          }
          const agent = summary.byAgent.get(owner);
          if (
            row.entry_valid === 1 &&
            summary.recent.length >= options.recentLimit &&
            (!agent || agent.recent.length >= options.recentLimit)
          ) {
            summary.count += 1;
            if (agent) {
              agent.count += 1;
            }
            continue;
          }
          candidates.push({ sessionKey: row.session_key, entryValid: row.entry_valid, agent });
          if (candidates.length >= batchSize) {
            readCandidates();
          }
        }
        readCandidates();
        return summary;
      }),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : summary;
}
