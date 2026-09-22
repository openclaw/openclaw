import { expectDefined } from "@openclaw/normalization-core";
import { readAcpSessionMetaForEntries } from "../acp/runtime/session-meta-readonly.js";
import { getSubagentSessionListReadSnapshotIdentity } from "../agents/subagents/registry/subagent-registry-state.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { captureCanonicalSessionReaderContinuation } from "../config/sessions/session-canonical-key.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreReadCandidate,
} from "../config/sessions/session-store-read-candidates.js";
import { withSessionHistoryWorkerDatabases } from "../config/sessions/session-transcript-worker-runtime.js";
import {
  MAX_SESSION_ROW_FACTS_KEYS,
  type SessionRowDatabaseFacts,
} from "../config/sessions/session-transcript-worker.types.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";
import { resolveStateDir } from "../config/state-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { retainOpenClawAgentDatabaseReadCandidates } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { isColdArchivedSessionRow } from "./session-row-projection-archive.js";
import { identity, isCurrentGeneration, type Row } from "./session-row-projection-record.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";

export type PreparedSessionRowDatabaseFacts = SessionRowDatabaseFacts & {
  acpMeta: SessionAcpMeta | null;
};

/** Retain each selected store until its prepared rows have been consumed by the projection. */
export async function withSessionRowDatabaseFacts(
  owner: {
    rows: ReadonlyMap<string, Row>;
    dirty: ReadonlySet<string>;
    revision: () => number | undefined;
    cfg: OpenClawConfig;
    selected?: ReadonlySet<string>;
  },
  consume: (
    ids: readonly string[],
    facts: ReadonlyMap<string, PreparedSessionRowDatabaseFacts>,
  ) => void,
): Promise<void> {
  const revision = owner.revision();
  const registrySnapshot = getSubagentSessionListReadSnapshotIdentity();
  const ids: string[] = [];
  for (const id of owner.selected ?? owner.dirty) {
    ids.push(id);
    if (ids.length === MAX_SESSION_ROW_FACTS_KEYS) {
      break;
    }
  }
  const rows = ids.flatMap((id) => owner.rows.get(id) ?? []);
  const env = cloneEnvWithPlatformSemantics(process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const groups = new Map<
    string,
    {
      database: { agentId: string; path: string; env: NodeJS.ProcessEnv };
      candidate: ReturnType<typeof captureSessionStoreReadCandidate>;
      rows: Row[];
    }
  >();
  for (const row of rows) {
    const agentId = normalizeAgentId(row.storeTarget.agentId);
    const pathname = resolveOpenClawAgentSqlitePath({
      agentId,
      path: row.storeTarget.storePath,
      env,
    });
    const key = JSON.stringify([agentId, pathname]);
    let group = groups.get(key);
    if (!group) {
      const candidate = captureSessionStoreReadCandidate(pathname);
      group = {
        database: { agentId, path: candidate.physicalPath, env },
        candidate,
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  const selected = [...groups.values()];
  const native = retainOpenClawAgentDatabaseReadCandidates(
    selected.flatMap(({ candidate }) => [
      candidate,
      { ...candidate, path: candidate.physicalPath },
    ]),
    env,
  );
  const continuations: Array<{
    agentId: string;
    path: string;
    owner: NonNullable<ReturnType<typeof captureCanonicalSessionReaderContinuation>>;
  }> = [];
  const assertCurrent = () => {
    for (const { candidate } of selected) {
      assertSessionStoreReadCandidate(candidate.path, [candidate]);
    }
    for (const continuation of continuations) {
      continuation.owner.assertCurrent();
    }
  };
  try {
    for (const database of native.databases) {
      const continuation = captureCanonicalSessionReaderContinuation(database);
      if (continuation) {
        continuations.push({
          agentId: database.agentId,
          path: captureSessionStoreReadCandidate(database.path).physicalPath,
          owner: continuation,
        });
      }
    }
    assertCurrent();
    await withSessionHistoryWorkerDatabases(
      selected.map(({ database }) => database),
      async (owners) => {
        const facts = new Map<string, PreparedSessionRowDatabaseFacts>();
        // Finish each accepted read before releasing any captured database owner on failure.
        for (const [index, group] of selected.entries()) {
          const databaseOwner = expectDefined(owners[index], "captured session row database");
          const continuation = continuations.find(
            (item) => item.agentId === group.database.agentId && item.path === group.database.path,
          )?.owner;
          const reply = await databaseOwner.readRowFacts({
            env,
            sessionKeys: [...new Set(group.rows.map((row) => row.key))],
            continuation: continuation?.receipt,
          });
          continuation?.assertCurrent();
          const byKey = new Map(reply.rows.map((row) => [row.sessionKey, row]));
          for (const row of group.rows) {
            const prepared = byKey.get(row.key);
            if (prepared) {
              facts.set(identity(row), { ...prepared, acpMeta: prepared.entry?.acp ?? null });
            }
          }
        }
        const acpRows = rows.flatMap((row) => {
          const prepared = facts.get(identity(row));
          return prepared?.entry && !prepared.entry.acp
            ? [{ row, prepared, entry: prepared.entry }]
            : [];
        });
        const acpMetadata = await readAcpSessionMetaForEntries({
          env,
          cfg: owner.cfg,
          entries: acpRows.map(({ row, entry }) => ({
            agentId: row.agentId,
            sessionKey: resolveStoredSessionKeyForAgentStore({
              cfg: owner.cfg,
              agentId: row.agentId,
              sessionKey: row.key,
            }),
            entry,
          })),
        });
        for (const [index, { prepared }] of acpRows.entries()) {
          prepared.acpMeta = acpMetadata[index] ?? null;
        }
        for (const databaseOwner of owners) {
          databaseOwner.assertCurrent();
        }
        assertCurrent();
        if (
          revision !== undefined &&
          owner.revision() === revision &&
          registrySnapshot === getSubagentSessionListReadSnapshotIdentity()
        ) {
          const currentIds = rows
            .filter(
              (row) =>
                (owner.dirty.has(identity(row)) ||
                  (owner.selected?.has(identity(row)) &&
                    isColdArchivedSessionRow(owner.rows.get(identity(row)) ?? row))) &&
                isCurrentGeneration(row, owner.rows.get(identity(row))),
            )
            .map(identity);
          consume(currentIds, facts);
          assertCurrent();
        }
      },
    );
  } finally {
    for (const continuation of continuations.toReversed()) {
      continuation.owner.release();
    }
    native.release();
  }
}
