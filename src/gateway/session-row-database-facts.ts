import { expectDefined } from "@openclaw/normalization-core";
import {
  readSessionRuntimeOwnershipAsync,
  SessionRuntimeOwnershipChanged,
} from "../agents/harness/session-runtime-ownership.js";
import { readSessionActorRowFacts } from "../config/sessions/session-actor-replica.js";
import { captureSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import { projectionLane } from "../config/sessions/session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabases } from "../config/sessions/session-transcript-worker-runtime.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "../config/sessions/session-transcript-worker.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { capturePluginStateReadDependencies } from "../plugin-state/plugin-state-publication.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { isColdArchivedSessionRow } from "./session-row-projection-archive.js";
import {
  canRetainSessionRowRuntimeOwnership,
  identity,
  isCurrentGeneration,
  isPreparedSessionRowDatabaseFacts,
  type RetainedSessionRowDatabaseFacts,
  type PreparedSessionRowDatabaseFacts,
  type Row,
} from "./session-row-projection-record.js";
import { prepareSessionRowSharedFacts } from "./session-row-projection-shared-facts.js";

/** Worker read owners retain each physical source through current row-facts installation. */
export async function withSessionRowDatabaseFacts(
  owner: {
    rows: ReadonlyMap<string, Row>;
    dirty: ReadonlySet<string>;
    isActive: () => boolean;
    prepareRegistryFacts: () => Promise<void> | undefined;
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    selected?: ReadonlySet<string>;
  },
  consume: {
    refreshPending: (ids: readonly string[]) => boolean;
    accept: (
      ids: readonly string[],
      facts: ReadonlyMap<string, PreparedSessionRowDatabaseFacts>,
    ) => void;
  },
): Promise<void> {
  const ids: string[] = [];
  for (const id of owner.selected ?? owner.dirty) {
    ids.push(id);
    if (ids.length === MAX_SESSION_ROW_FACTS_KEYS) {
      break;
    }
  }
  // New dirty keys append after this batch; finish its accepted rows before another read.
  if (consume.refreshPending(ids)) {
    return;
  }
  const retained = new Map<string, PreparedSessionRowDatabaseFacts>();
  for (const id of ids) {
    const facts = owner.rows.get(id)?.retainedDatabaseFacts;
    if (
      facts &&
      isPreparedSessionRowDatabaseFacts(facts) &&
      canRetainSessionRowRuntimeOwnership(facts)
    ) {
      retained.set(id, facts);
    }
  }
  if (retained.size > 0) {
    // Related-row changes retain stored facts but still need current lineage.
    consume.accept([...retained.keys()], retained);
    return;
  }
  const rows = ids.flatMap((id) => owner.rows.get(id) ?? []);
  const rowRevisions = new Map(rows.map((row) => [identity(row), row.databaseFactsRevision]));
  const env = owner.env;
  const shared = captureOpenClawStateReadWorkerContext({
    env,
    path: resolveOpenClawStateSqlitePath(env),
  });
  const groups = new Map<
    string,
    {
      database: {
        agentId: string;
        path: string;
        requestedPaths: string[];
        env: NodeJS.ProcessEnv;
      };
      rows: Row[];
    }
  >();
  const actorFacts = new Map<string, RetainedSessionRowDatabaseFacts>();
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
        database: { agentId, path: candidate.physicalPath, requestedPaths: [candidate.path], env },
        rows: [],
      };
      groups.set(key, group);
    }
    if (!row.retainedDatabaseFacts) {
      const facts = readSessionActorRowFacts({
        path: group.database.path,
        sessionKey: row.key,
      });
      if (facts) {
        actorFacts.set(identity(row), facts);
      } else {
        group.rows.push(row);
      }
    }
  }
  const readGroups = [...groups.values()].filter((group) => group.rows.length > 0);
  const ownershipReads = new Map<
    string,
    Awaited<ReturnType<typeof capturePluginStateReadDependencies>>
  >();
  try {
    await withSessionHistoryWorkerDatabases(
      readGroups.map(({ database }) => database),
      async (owners) => {
        const facts = new Map<string, RetainedSessionRowDatabaseFacts>(
          rows.flatMap((row) => {
            const previous = row.retainedDatabaseFacts;
            if (!previous) {
              return [];
            }
            const prepared = { ...previous };
            if (
              isPreparedSessionRowDatabaseFacts(previous) &&
              !canRetainSessionRowRuntimeOwnership(previous)
            ) {
              prepared.runtimeOwnership = undefined;
              prepared.runtimeOwnershipDependencies = undefined;
            }
            return [[identity(row), prepared]];
          }),
        );
        for (const [id, row] of actorFacts) {
          facts.set(id, row);
        }
        // Finish each accepted read before releasing any captured database owner on failure.
        for (const [index, group] of readGroups.entries()) {
          const databaseOwner = expectDefined(owners[index], "captured session row database");
          const reply = await databaseOwner.readRowFacts({
            env,
            sessionKeys: [...new Set(group.rows.map((row) => row.key))],
          });
          const byKey = new Map(reply.rows.map((row) => [row.sessionKey, row]));
          for (const row of group.rows) {
            const prepared = byKey.get(row.key);
            if (prepared) {
              facts.set(identity(row), { ...prepared });
            }
          }
        }
        const sharedRead = prepareSessionRowSharedFacts({ rows, facts, env, shared });
        if (sharedRead) {
          sharedRead.accept(await sharedRead.reply);
        }
        for (const row of rows) {
          const prepared = facts.get(identity(row));
          if (prepared && prepared.runtimeOwnership === undefined) {
            try {
              const ownership = await capturePluginStateReadDependencies(() =>
                readSessionRuntimeOwnershipAsync({
                  config: owner.cfg,
                  agentId: row.agentId,
                  sessionKey: row.key,
                  storePath: row.storeTarget.storePath,
                  sessionEntry: prepared.entry,
                  readPreparedPreviousSessionId: () => prepared.entry?.previousSessionId,
                }),
              );
              ownershipReads.set(identity(row), ownership);
              prepared.runtimeOwnership = ownership.value ?? null;
              prepared.runtimeOwnershipDependencies = ownership.dependencies;
            } catch (error) {
              if (!(error instanceof SessionRuntimeOwnershipChanged)) {
                throw error;
              }
              // Descriptive ownership may be absent until this row's next invalidation.
              prepared.runtimeOwnership = null;
              prepared.runtimeOwnershipDependencies = [];
            }
          }
        }
        const preparedFacts = new Map<string, PreparedSessionRowDatabaseFacts>();
        for (const [id, row] of facts) {
          if (isPreparedSessionRowDatabaseFacts(row)) {
            preparedFacts.set(id, row);
          }
        }
        // Registry renewal changes presentation, not the captured SQLite facts.
        // Prepare the current lineage before accepting those facts instead of reading them again.
        await owner.prepareRegistryFacts();
        for (const databaseOwner of owners) {
          databaseOwner.assertCurrent();
        }
        sharedRead?.assertCurrent();
        if (owner.isActive()) {
          const currentIds = rows
            .filter(
              (row) =>
                (owner.dirty.has(identity(row)) ||
                  (owner.selected?.has(identity(row)) &&
                    isColdArchivedSessionRow(owner.rows.get(identity(row)) ?? row))) &&
                isCurrentGeneration(row, owner.rows.get(identity(row))) &&
                owner.rows.get(identity(row))?.databaseFactsRevision ===
                  rowRevisions.get(identity(row)) &&
                (ownershipReads.get(identity(row))?.isCurrent() ?? true),
            )
            .map(identity);
          consume.accept(currentIds, preparedFacts);
        }
      },
      projectionLane,
    );
  } finally {
    for (const ownership of ownershipReads.values()) {
      ownership.release();
    }
  }
}
