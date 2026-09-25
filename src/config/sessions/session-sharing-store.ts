import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  hasSessionMemberInDatabase,
  listSessionMembersInDatabase,
  type SessionMember,
} from "./session-sharing-store.kernel.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

function resolveDatabaseOptions(scope: SessionAccessScope): OpenClawAgentDatabaseOptions {
  return toDatabaseOptions(resolveSqliteScope(scope));
}

function readSessionMembers<T>(
  scope: SessionAccessScope,
  fallback: T,
  operation: (database: Pick<OpenClawAgentDatabase, "db">) => T,
): T {
  const result = withOpenClawAgentDatabaseReadOnly(operation, resolveDatabaseOptions(scope));
  return result.found ? result.value : fallback;
}

export function listSessionMembers(scope: SessionAccessScope): SessionMember[] {
  return readSessionMembers(scope, [], (database) =>
    listSessionMembersInDatabase(database, resolveSqliteScope(scope).sessionKey),
  );
}

/** Full membership evidence shares the existing read-only agent database worker. */
export async function listSessionMembersInWorker(
  input: SessionAccessScope,
): Promise<SessionMember[]> {
  const env = { ...(input.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const resolved = resolveSqliteScope({ ...input, env });
  const options = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  if (isIncognitoOpenClawAgentSqlitePath(databasePath, options)) {
    // Incognito SQLite exists only in this process and keeps its native owner.
    return listSessionMembers({ ...input, env });
  }
  return await withSessionHistoryWorkerDatabase(options, (owner) =>
    owner.readMembers({ sessionKey: resolved.sessionKey, env }),
  );
}

export function isSessionMember(scope: SessionAccessScope, identityId: string): boolean {
  const normalizedIdentityId = identityId.trim();
  if (!normalizedIdentityId) {
    return false;
  }
  return readSessionMembers(scope, false, (database) =>
    hasSessionMemberInDatabase(
      database,
      resolveSqliteScope(scope).sessionKey,
      normalizedIdentityId,
    ),
  );
}

export {
  addSessionMemberInWorker as addSessionMember,
  removeSessionMemberInWorker as removeSessionMember,
} from "./session-sharing-store.async.js";
