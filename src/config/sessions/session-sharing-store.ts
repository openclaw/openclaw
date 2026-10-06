import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import {
  hasSessionMemberInDatabase,
  listSessionMembersInDatabase,
  type SessionMember,
} from "./session-sharing-store.kernel.js";
import { projectionLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

function readSessionMembers<T>(
  scope: SessionAccessScope,
  fallback: T,
  operation: (database: Pick<OpenClawAgentDatabase, "db">, sessionKey: string) => T,
): T {
  const resolved = resolveSqliteScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => operation(database, resolved.sessionKey),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : fallback;
}

export function listSessionMembers(scope: SessionAccessScope): SessionMember[] {
  return readSessionMembers(scope, [], listSessionMembersInDatabase);
}

/** Full membership evidence shares the existing read-only agent database worker. */
export async function listSessionMembersInWorker(
  input: SessionCollaborationScope,
): Promise<SessionMember[]> {
  const env = { ...(input.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const resolved = resolveSqliteScope({ ...input, env });
  const options = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  if (input.incognito) {
    const { actor, authority } = input.incognito;
    if (actor.agentId !== resolved.agentId || actor.path !== databasePath) {
      throw new Error("Membership target differs from its captured incognito actor");
    }
    const members = await actor.sessions.sideData(authority, {
      type: "session.members.read",
      input: { sessionKey: resolved.sessionKey },
    });
    authority.assertCurrent();
    actor.assertReadable();
    return members;
  }
  if (isIncognitoOpenClawAgentSqlitePath(databasePath, options)) {
    // Incognito SQLite exists only in this process and keeps its native owner.
    return listSessionMembers({ ...input, env });
  }
  return await withSessionHistoryWorkerDatabase(
    options,
    (owner) => owner.readMembers({ sessionKey: resolved.sessionKey, env }),
    projectionLane,
  );
}

export function isSessionMember(scope: SessionAccessScope, identityId: string): boolean {
  const normalizedIdentityId = identityId.trim();
  if (!normalizedIdentityId) {
    return false;
  }
  return readSessionMembers(scope, false, (database, sessionKey) =>
    hasSessionMemberInDatabase(database, sessionKey, normalizedIdentityId),
  );
}

export {
  addSessionMemberInWorker as addSessionMember,
  removeSessionMemberInWorker as removeSessionMember,
} from "./session-sharing-store.async.js";
