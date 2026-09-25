import { toUSVString } from "node:util";
import { iterateSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { collectActiveSessionWorkAdmissions } from "../../sessions/session-lifecycle-admission.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { collectAdmissionProtectedSessionIds } from "./session-history-eviction.js";
import { normalizeStoreSessionKey } from "./store-entry.js";

/**
 * Admission protection for one candidate, read with queries narrowed to the
 * generations that candidate owns.
 *
 * `collectAdmissionProtectedSessionIds` answers the same question for a whole
 * store, but to do so it folds every stored key through
 * `normalizeStoreSessionKey` — which trims, case-folds legacy keys and rewrites
 * thread suffixes, so it cannot become a SQL predicate. A caller that walks many
 * candidates therefore pays a store-sized enumeration per candidate.
 *
 * This form keeps the same protections without that enumeration:
 * - an admission on the candidate's own key holds every generation it owns;
 * - an admission naming a generation id directly holds that id;
 * - a generation shared with a different admitted key stays held, read with one
 *   `session_id`-narrowed window query.
 *
 * The unbounded form additionally resolves each admitted key's *entry* into the
 * ids it references. For a candidate whose own key is not admitted, that set is
 * already covered by a candidate-narrowed `readReferencedSessionIds`, which
 * walks every node entry — admitted or not — for references to the same ids.
 * Compose this probe with that scan; it is not a standalone replacement.
 */
export function collectAdmissionProtectedCandidateSessionIds(params: {
  candidateSessionIds: readonly string[];
  candidateSessionKey: string;
  database: Pick<OpenClawAgentDatabase, "db">;
  storePath: string;
}): Set<string> {
  const protectedSessionIds = new Set<string>();
  if (params.candidateSessionIds.length === 0) {
    return protectedSessionIds;
  }
  const admissionIdentities =
    collectActiveSessionWorkAdmissions().get(params.storePath) ?? new Set<string>();
  if (admissionIdentities.size === 0) {
    return protectedSessionIds;
  }
  // Narrowing is only safe for ids SQLite text binding returns unchanged; anything
  // else falls back to the store-wide probe rather than risk missing a holder.
  const bindable = params.candidateSessionIds.every(
    (sessionId) => toUSVString(sessionId) === sessionId && !/[\0￾￿]/u.test(sessionId),
  );
  if (!bindable) {
    return collectAdmissionProtectedSessionIds(params);
  }
  const normalizedAdmissionKeys = new Set(
    [...admissionIdentities].map((identity) => normalizeStoreSessionKey(identity)),
  );
  if (normalizedAdmissionKeys.has(normalizeStoreSessionKey(params.candidateSessionKey))) {
    for (const sessionId of params.candidateSessionIds) {
      protectedSessionIds.add(sessionId);
    }
    return protectedSessionIds;
  }
  for (const sessionId of params.candidateSessionIds) {
    if (admissionIdentities.has(sessionId)) {
      protectedSessionIds.add(sessionId);
    }
  }
  const db = getSessionKysely(params.database.db);
  // Key-scoped admissions must survive rollover: an in-flight run admitted by
  // key may still write to a generation the entry no longer references, so a
  // generation an admitted key owns stays off-limits. `session_windows.session_id`
  // is the table's primary key today, so this normally re-reads only the
  // candidate's own rows as an index seek; it stays here rather than resting the
  // probe's protection on that invariant holding forever.
  for (const row of iterateSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_windows")
      .select(["session_id", "session_key"])
      .where("session_id", "in", sqliteStringSet(params.candidateSessionIds)),
  )) {
    if (normalizedAdmissionKeys.has(normalizeStoreSessionKey(row.session_key))) {
      protectedSessionIds.add(row.session_id);
    }
  }
  return protectedSessionIds;
}
