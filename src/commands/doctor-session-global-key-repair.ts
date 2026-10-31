import { createHash } from "node:crypto";
import { listAgentIds } from "../agents/agent-scope-config.js";
import {
  applySessionEntryLifecycleMutation,
  loadExactSessionEntryReadOnly,
  rehomeSessionDeliveryReferencesForCanonicalRepair,
} from "../config/sessions/session-accessor.js";
import { rehomeSessionWindows } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { replaceSessionOwnerInTransaction } from "../config/sessions/session-accessor.sqlite-owner.js";
import { getSessionKysely } from "../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readCronSessionHistoryForRepair,
  rehomeCronSessionHistoryForRepair,
} from "../cron/store/run-history.kernel.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  resolveTargetSqliteOptions,
  type ExistingAgentDatabaseTarget,
} from "../infra/session-sqlite-migration-readers.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { DoctorSqliteMaintenanceAuthority } from "./doctor-sqlite-maintenance-lock.js";

export type GlobalSessionKeyRepair = { from: string; to: string; applied: boolean };

function recoveredKey(agentId: string, sessionId: string): string {
  const identity = createHash("sha256").update(sessionId).digest("hex").slice(0, 20);
  return `agent:${agentId}:global-review-${identity}`;
}

/** Recover the colliding review binding; normal runtime identity handling then suffices. */
export async function repairOverlappingGlobalSessionKeys(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stores: readonly ExistingAgentDatabaseTarget[];
  authority?: DoctorSqliteMaintenanceAuthority;
}): Promise<GlobalSessionKeyRepair[]> {
  const repaired: GlobalSessionKeyRepair[] = [];
  const configuredAgents = new Set(listAgentIds(params.cfg));
  for (const store of params.stores) {
    if (!configuredAgents.has(store.agentId)) {
      continue;
    }
    const scope = { agentId: store.agentId, storePath: store.storePath, env: params.env };
    const from = `agent:${store.agentId}:global`;
    const read = (sessionKey: string) => loadExactSessionEntryReadOnly({ ...scope, sessionKey });
    const options = resolveTargetSqliteOptions(store, params.env);
    const stored = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("session_nodes")
            .select(["session_key", "current_session_id"])
            .where("session_key", "in", ["global", from]),
        ).rows,
      options,
    );
    const identities = stored.found ? stored.value : [];
    const ongoing = identities.find((row) => row.session_key === "global");
    const literal = identities.find((row) => row.session_key === from);
    if (!ongoing || literal?.current_session_id === ongoing.current_session_id) {
      continue;
    }
    // Preview needs binding identities only; the ordinary repair owns legacy entry metadata.
    if (!params.apply && literal) {
      repaired.push({
        from,
        to: recoveredKey(store.agentId, literal.current_session_id),
        applied: false,
      });
      continue;
    }
    const original = read(from);
    let candidate = original;
    if (!candidate) {
      const pending =
        withExistingOpenClawStateDatabaseReadOnly(
          ({ db }) =>
            readCronSessionHistoryForRepair(db, { agentId: store.agentId, fromSessionKey: from }),
          { env: params.env },
        ) ?? [];
      if (pending.length === 0) {
        continue;
      }
      const sessionIds = [...new Set(pending.map((row) => row.sessionId))];
      const inspected = withOpenClawAgentDatabaseReadOnly(
        (database) =>
          executeSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .selectFrom("session_windows")
              .select("session_key")
              .distinct()
              .where("session_id", "in", sessionIds),
          ).rows,
        options,
      );
      const bindings = inspected.found ? inspected.value : [];
      const [binding] = bindings;
      if (!binding || bindings.length !== 1) {
        throw new Error(
          `Cannot recover ${from}: retained runs do not identify one recovered chat.`,
        );
      }
      candidate = read(binding.session_key);
      if (
        !candidate ||
        recoveredKey(store.agentId, candidate.entry.sessionId) !== binding.session_key
      ) {
        throw new Error(`Cannot recover ${from}: its recovered history binding changed.`);
      }
    }
    const to = recoveredKey(store.agentId, candidate.entry.sessionId);
    if (original?.entry.repositoryWorkspaceId) {
      throw new Error(`Cannot recover ${from}: its repository workspace binding needs resolution.`);
    }
    if (candidate.entry.resumeAfterRestart) {
      throw new Error(`Cannot recover ${from}: its accepted work must finish first.`);
    }
    if (original && read(to)) {
      throw new Error(`Cannot recover ${from}: destination ${to} is already occupied.`);
    }
    const sourceKey = original ? from : to;
    const inspected = withOpenClawAgentDatabaseReadOnly((database) => {
      const db = getSessionKysely(database.db);
      const pending = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_pending_inputs")
          .select("input_id")
          .where("session_key", "=", sourceKey)
          .limit(1),
      ).rows;
      const linked = executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_nodes")
          .select("session_key")
          .where((eb) =>
            eb.or([
              eb("parent_session_key", "=", from),
              eb("spawned_by", "=", from),
              eb("fork_source_session_key", "=", from),
            ]),
          )
          .limit(1),
      ).rows;
      if (pending.length || linked.length) {
        throw new Error(
          `Cannot recover ${from}: pending input or linked sessions need resolution.`,
        );
      }
      return executeSqliteQuerySync(
        database.db,
        db.selectFrom("session_windows").select("session_id").where("session_key", "=", sourceKey),
      ).rows.map((row) => row.session_id);
    }, options);
    if (!inspected.found || !inspected.value.includes(candidate.entry.sessionId)) {
      throw new Error(`Cannot recover ${from}: its stored history binding changed.`);
    }
    const history = {
      agentId: store.agentId,
      fromSessionKey: from,
      toSessionKey: to,
      sessionIds: inspected.value,
    };
    const references =
      withExistingOpenClawStateDatabaseReadOnly(
        ({ db: database }) => {
          const db = getNodeSqliteKysely<DB>(database);
          if (original) {
            const repository = tableExists(database, "session_repository_workspaces")
              ? executeSqliteQuerySync(
                  database,
                  db
                    .selectFrom("session_repository_workspaces")
                    .select("workspace_id")
                    .where("agent_id", "=", store.agentId)
                    .where("session_key", "=", from)
                    .limit(1),
                ).rows
              : [];
            const placements = executeSqliteQuerySync(
              database,
              db
                .selectFrom("worker_session_placements")
                .select("session_id")
                .where("agent_id", "=", store.agentId)
                .where((eb) =>
                  eb.or([eb("session_key", "=", from), eb("session_id", "in", history.sessionIds)]),
                )
                .limit(1),
            ).rows;
            if (repository.length || placements.length) {
              throw new Error(`Cannot recover ${from}: its workspace binding needs resolution.`);
            }
          }
          const linked = executeSqliteQuerySync(
            database,
            db
              .selectFrom("subagent_runs")
              .select("run_id")
              .where((eb) =>
                eb.or([
                  eb("child_session_key", "=", from),
                  eb("controller_session_key", "=", from),
                  eb("requester_session_key", "=", from),
                ]),
              )
              .limit(1),
          ).rows;
          const watched = executeSqliteQuerySync(
            database,
            db
              .selectFrom("session_watch_cursors")
              .select("target_session_key")
              .where((eb) =>
                eb.or([eb("watcher_session_key", "=", from), eb("target_session_key", "=", from)]),
              )
              .limit(1),
          ).rows;
          const approvals = executeSqliteQuerySync(
            database,
            db
              .selectFrom("operator_approvals")
              .select("approval_id")
              .where("source_session_key", "=", from)
              .where("status", "=", "pending")
              .limit(1),
          ).rows;
          const published = tableExists(database, "github_publication_requests")
            ? executeSqliteQuerySync(
                database,
                db
                  .selectFrom("github_publication_requests")
                  .select("request_id")
                  .where("session_key", "=", from)
                  .where("agent_id", "=", store.agentId)
                  .limit(1),
              ).rows
            : [];
          if (linked.length || watched.length || approvals.length || published.length) {
            throw new Error(
              `Cannot recover ${from}: linked work or publication references need resolution.`,
            );
          }
          return rehomeCronSessionHistoryForRepair(database, { ...history, apply: false });
        },
        { env: params.env },
      ) ?? 0;
    if (!original && references === 0) {
      continue;
    }
    if (params.apply) {
      const authority = params.authority;
      if (!authority) {
        throw new Error("Global chat recovery requires exclusive Doctor maintenance ownership.");
      }
      authority.assertCurrent();
      if (original) {
        const database = openOpenClawAgentDatabase(options);
        await applySessionEntryLifecycleMutation({
          ...scope,
          allowCanonicalRepair: true,
          skipMaintenance: true,
          commitGuard: () => authority.assertCurrent(),
          beforeCommitInTransaction: () => {
            authority.assertCurrent();
            const targets = executeSqliteQuerySync(
              database.db,
              getSessionKysely(database.db)
                .selectFrom("session_nodes")
                .select(["session_key", "current_session_id"])
                .where("session_key", "in", ["global", to]),
            ).rows;
            if (
              targets.some((row) => row.session_key === to) ||
              !targets.some(
                (row) =>
                  row.session_key === "global" &&
                  row.current_session_id === ongoing.current_session_id,
              )
            ) {
              throw new Error(`Cannot recover ${from}: the selected pair or destination changed.`);
            }
          },
          upserts: [{ sessionKey: to, entry: original.entry }],
          afterUpsertsInTransaction: (target) => {
            replaceSessionOwnerInTransaction(target, to, original.entry.owner);
            rehomeSessionWindows(target, to, [from]);
            rehomeSessionDeliveryReferencesForCanonicalRepair(target, to, [from]);
          },
          removals: [
            {
              sessionKey: from,
              exactStoredKey: true,
              expectedEntry: original.entry,
              archiveRemovedTranscript: false,
              deleteOwnedWindows: false,
            },
          ],
        });
      }
      // A retry can discover the committed destination by its original SID without a journal.
      if (references > 0) {
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            authority.assertCurrent();
            return rehomeCronSessionHistoryForRepair(db, { ...history, apply: true });
          },
          { env: params.env },
          { operationLabel: "doctor.rehome-global-review-history" },
        );
      }
    }
    repaired.push({ from, to, applied: params.apply });
  }
  return repaired;
}
