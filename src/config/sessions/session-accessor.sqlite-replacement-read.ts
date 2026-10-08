import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionEntryReplacementSnapshot } from "./session-accessor.sqlite-contract.js";
import { iterateSessionEntryKeys } from "./session-accessor.sqlite-entry-inventory.js";
import {
  prepareExactSessionEntryRowReads,
  readExactSessionEntryRow,
  type ResolvedSessionEntryRow,
} from "./session-accessor.sqlite-entry-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope-helpers.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";

export type SessionEntryReplacementSelection = {
  sessionKeys?: readonly string[];
  includeLabelOwners?: string;
};

export type SessionEntryReplacementState = {
  entries: SessionEntryReplacementSnapshot[];
  expectedRows: Map<string, ResolvedSessionEntryRow>;
  labelOwnerKeys: string[];
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

function selectReplacementKeys(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">,
  params: SessionEntryReplacementSelection,
  labelOwnerKeys: readonly string[],
): string[] {
  if (params.sessionKeys) {
    return uniqueStrings([...params.sessionKeys, ...labelOwnerKeys]);
  }
  assertCanonicalSqliteSessionKeysCurrent(database);
  return [...iterateSessionEntryKeys(database)];
}

/** Detached entries and their CAS bytes must come from the same admitted read snapshot. */
export function readSessionEntryReplacementState(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">,
  params: SessionEntryReplacementSelection,
): SessionEntryReplacementState {
  const selectedKeys = params.sessionKeys ? new Set(params.sessionKeys) : undefined;
  const labelOwnerKeys = readSessionEntryReplacementLabelOwnerKeys(
    database,
    params.includeLabelOwners,
  );
  const selected = selectReplacementKeys(database, params, labelOwnerKeys);
  const expectedRows = new Map<string, ResolvedSessionEntryRow>();
  const readPrepared =
    selected.length > 1 ? prepareExactSessionEntryRowReads(database, selected) : undefined;
  const entries = selected.flatMap((sessionKey) => {
    const row = readPrepared
      ? readPrepared(sessionKey)
      : readExactSessionEntryRow(database, sessionKey);
    if (!row) {
      if (!selectedKeys) {
        throw new Error(`SQLite session entry changed before replacement for ${sessionKey}`);
      }
      return [];
    }
    expectedRows.set(sessionKey, row);
    return [{ entry: structuredClone(row.entry), sessionKey }];
  });
  return { entries, expectedRows, labelOwnerKeys };
}
