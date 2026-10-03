import type { DatabaseFileIdentity } from "../../infra/sqlite-worker-identity.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";

// Private caller conditions follow the existing assertion into the native write owner.
// They do not issue or replace acknowledged transcript provenance.
const sourceRestrictions = resolveGlobalSingleton(
  Symbol.for("openclaw.transcriptSourceCommitRestrictions"),
  () => new WeakMap<() => void, () => DatabaseFileIdentity | undefined>(),
);

export function registerTranscriptSourceCommitRestriction(
  assertion: () => void,
  expectedDatabase: () => DatabaseFileIdentity | undefined,
): void {
  sourceRestrictions.set(assertion, expectedDatabase);
}

export function assertTranscriptSourceCommitDatabase(
  assertion: (() => void) | undefined,
  admittedDatabase: DatabaseFileIdentity | undefined,
): void {
  const expected = assertion ? sourceRestrictions.get(assertion)?.() : undefined;
  if (
    expected &&
    (!admittedDatabase ||
      expected.key !== admittedDatabase.key ||
      expected.birthtime !== admittedDatabase.birthtime)
  ) {
    throw new Error("Transcript input commit must retain its original physical source database.");
  }
}

/** Released native scopes use the same condition against their registered transaction owner. */
export function assertTranscriptSourceCommitNativeDatabase(
  assertion: (() => void) | undefined,
  database: OpenClawAgentDatabase,
): void {
  if (!assertion || !sourceRestrictions.get(assertion)?.()) {
    return;
  }
  const owner = readOpenClawAgentDatabaseIdentity(database);
  assertTranscriptSourceCommitDatabase(
    assertion,
    typeof owner.identity === "string"
      ? { key: `file:${owner.identity}`, birthtime: owner.birthtime }
      : undefined,
  );
}
