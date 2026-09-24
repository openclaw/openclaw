import type { DatabaseSync } from "node:sqlite";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";
import { readUserProfileAliases } from "../../state/user-profile-list.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { isNewerSessionMention, mergeSessionProfileInvolvement } from "./session-involvement.js";
import type { SessionProfileInvolvement } from "./types.js";

export type SessionProfileInvolvementChange =
  | { kind: "visibility"; hidden: boolean }
  | { kind: "mention"; source: NonNullable<SessionProfileInvolvement["lastMention"]> };

export type SessionProfileInvolvementWorkerInput = {
  agentId: string;
  env: { OPENCLAW_STATE_DIR: string };
};

export type SessionProfileInvolvementWorkerResult = { accepted: boolean; changed: boolean };

export type SessionProfileInvolvementWorkerOperations = {
  update: {
    input: {
      sessionKey: string;
      expectedSessionId: string;
      profileIds: readonly string[];
      change: SessionProfileInvolvementChange;
    };
    output: SessionProfileInvolvementWorkerResult;
  };
};

/** Borrows the canonical agent connection; profiles remain in the separate shared database. */
export function bindSqliteWorkerBackend(
  input: SessionProfileInvolvementWorkerInput,
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<SessionProfileInvolvementWorkerOperations> {
  const database = getOpenClawAgentDatabaseIfOpen({
    agentId: input.agentId,
    path: context.databasePath,
    env: input.env,
  });
  if (!database || database.db !== context.database) {
    throw new Error("Session involvement lost its canonical agent database");
  }
  const db = database.db;
  return {
    execute({ input: params }) {
      return withSqlitePostCommitPublications(db, () =>
        runSqliteImmediateTransactionSync(
          db,
          () => {
            context.admit("transaction");
            const current = readExactSessionEntryRow(database, params.sessionKey)?.entry;
            if (!current || current.sessionId !== params.expectedSessionId || current.incognito) {
              return { accepted: false, changed: false };
            }
            const involvement = { ...current.profileInvolvement?.profiles };
            let changed = false;
            for (const profileId of new Set(params.profileIds)) {
              const aliases = readUserProfileAliases(profileId, { env: input.env });
              const previous = mergeSessionProfileInvolvement(
                [...aliases].map((alias) => involvement[alias]),
              );
              const lastMention = previous?.lastMention;
              const change = params.change;
              // Inbox retention cannot turn an old source replay into a fresh mention.
              if (
                change.kind === "mention" &&
                lastMention &&
                !isNewerSessionMention(change.source, lastMention)
              ) {
                continue;
              }
              const hidden = change.kind === "visibility" && change.hidden;
              if (change.kind === "visibility" && previous?.hidden === hidden) {
                continue;
              }
              for (const alias of aliases) {
                delete involvement[alias];
              }
              involvement[profileId] = {
                hidden,
                updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1),
                ...(change.kind === "mention"
                  ? { lastMention: change.source }
                  : lastMention
                    ? { lastMention }
                    : {}),
              };
              changed = true;
            }
            if (changed) {
              writeSessionEntry(database, params.sessionKey, current, {
                canonicalPreviousEntry: current,
                profileInvolvement: { key: params.sessionKey, profiles: involvement },
              });
            }
            return { accepted: true, changed };
          },
          {
            operationLabel: "sessions.involvement",
            busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            databaseLabel: context.databasePath,
            withCommit(commit) {
              context.admit("commit");
              commit();
            },
          },
        ),
      );
    },
    assertSettled() {
      assertTransactionUsable(db);
      if (db.isTransaction) {
        throw new Error("Session involvement transaction did not settle");
      }
    },
    close() {},
  };
}
