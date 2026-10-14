import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionEntryReplacementSnapshot } from "./session-accessor.sqlite-contract.js";
import { iterateSessionEntryKeys } from "./session-accessor.sqlite-entry-inventory.js";
import {
  prepareExactSessionEntryRowReads,
  readExactSessionEntryRow,
  readSessionKeyBySessionIdInDatabase,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope-helpers.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";

export type SessionEntryReplacementSelection = {
  sessionKeys?: readonly string[];
  includeSessionWindowOwner?: string;
  includeLabelOwners?: string;
};

export type SessionEntryReplacementState = {
  entries: SessionEntryReplacementSnapshot[];
  expectedRows: Map<string, ResolvedSessionEntryRow>;
  labelOwnerKeys: string[];
  selectedSessionKeys?: string[];
};

export function readSessionEntryReplacementLabelOwnerKeys(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">,
  label: string | undefined,
): string[] {
  return label === undefined
    ? []
    : executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_nodes")
          .select("session_key")
          .where("label", "=", label)
          .orderBy("session_key"),
      ).rows.map((row) => row.session_key);
}

/** Detached entries and their CAS bytes must come from the same admitted read snapshot. */
export function readSessionEntryReplacementState(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">,
  params: SessionEntryReplacementSelection,
): SessionEntryReplacementState {
  const windowOwner = params.includeSessionWindowOwner
    ? readSessionKeyBySessionIdInDatabase(database, params.includeSessionWindowOwner)
    : undefined;
  const selectedSessionKeys = params.sessionKeys
    ? uniqueStrings([...params.sessionKeys, ...(windowOwner ? [windowOwner] : [])])
    : undefined;
  const labelOwnerKeys = readSessionEntryReplacementLabelOwnerKeys(
    database,
    params.includeLabelOwners,
  );
  if (!selectedSessionKeys) {
    assertCanonicalSqliteSessionKeysCurrent(database);
  }
  const selected = selectedSessionKeys
    ? uniqueStrings([...selectedSessionKeys, ...labelOwnerKeys])
    : [...iterateSessionEntryKeys(database)];
  const expectedRows = new Map<string, ResolvedSessionEntryRow>();
  const readPrepared =
    selected.length > 1 ? prepareExactSessionEntryRowReads(database, selected) : undefined;
  const entries = selected.flatMap((sessionKey) => {
    const row = readPrepared
      ? readPrepared(sessionKey)
      : readExactSessionEntryRow(database, sessionKey);
    if (!row) {
      return [];
    }
    expectedRows.set(sessionKey, row);
    return [{ entry: structuredClone(row.entry), sessionKey }];
  });
  return { entries, expectedRows, labelOwnerKeys, selectedSessionKeys };
}
