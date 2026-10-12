import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import {
  captureIncognitoSessionOperation,
  captureIncognitoSessionSource,
} from "./session-incognito-binding.js";
import type { SessionMember } from "./session-membership-facts.types.js";
import {
  hasSessionMemberInDatabase,
  listSessionMembersInDatabase,
  readSessionMembersInDatabase,
  type SessionMembersSnapshot,
} from "./session-sharing-store.kernel.js";
import { projectionLane } from "./session-transcript-worker-resources.js";

function readSessionMembers<T>(
  scope: SessionAccessScope,
  fallback: T,
  operation: (database: Pick<OpenClawAgentDatabase, "agentId" | "db">, sessionKey: string) => T,
): T {
  const resolved = resolveSqliteScope(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => operation(database, resolved.sessionKey),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : fallback;
}

function readMemorySessionMembers(
  scope: SessionCollaborationScope,
): SessionMembersSnapshot | undefined {
  if (!isIncognitoSessionKey(scope.sessionKey)) {
    return undefined;
  }
  const memory = getSessionActorStorageBinding({ sessionActor: scope.sessionActor });
  if (!memory) {
    return undefined;
  }
  const agentId = scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey);
  const current =
    agentId === memory.agentId && scope.sessionKey.trim() === memory.actor.target.sessionKey
      ? getSessionActorStorageBinding(scope)!.actor.snapshot(memory.authority)
      : undefined;
  return structuredClone({ entry: current?.entry, members: current?.members ?? [] });
}

export function listSessionMembers(scope: SessionAccessScope): SessionMember[] {
  const memory = readMemorySessionMembers(scope);
  if (memory) {
    return memory.members;
  }
  return readSessionMembers(scope, [], listSessionMembersInDatabase);
}

/** Current management metadata and evidence share the projection worker's read snapshot. */
export async function readSessionMembersInWorker(
  input: SessionCollaborationScope,
): Promise<SessionMembersSnapshot> {
  const memory = readMemorySessionMembers(input);
  if (memory) {
    return memory;
  }
  const source = input.incognito ? undefined : captureIncognitoSessionSource(input);
  if (source && "kind" in source) {
    return { entry: undefined, members: [] };
  }
  const resolved = resolveSqliteScope(input);
  const env = { ...(resolved.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = toDatabaseOptions({ ...resolved, env });
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  const incognito = input.incognito ?? captureIncognitoSessionOperation(input);
  if (incognito) {
    const { actor, authority } = incognito;
    if (actor.agentId !== resolved.agentId || actor.path !== databasePath) {
      throw new Error("Membership target differs from its captured incognito actor");
    }
    const members = await actor.sessions.sideData(
      authority,
      { type: "session.members.read", input: { sessionKey: resolved.sessionKey } },
      source?.admissionSignal,
    );
    authority.assertCurrent();
    actor.assertReadable();
    return members;
  }
  if (isIncognitoOpenClawAgentSqlitePath(databasePath, options)) {
    // Incognito SQLite exists only in this process and keeps its native owner.
    return readSessionMembers(
      { ...input, env },
      { entry: undefined, members: [] },
      readSessionMembersInDatabase,
    );
  }
  return await withSessionStoreReaderInWorker(
    { agentId: options.agentId, storePath: databasePath, env },
    ({ reader, continuation }) =>
      reader.readMembers({ sessionKey: resolved.sessionKey, env, continuation }),
    { backing: true, dataOnly: true, lane: projectionLane },
  );
}

export function isSessionMember(scope: SessionAccessScope, identityId: string): boolean {
  const normalizedIdentityId = identityId.trim();
  if (!normalizedIdentityId) {
    return false;
  }
  const memory = readMemorySessionMembers(scope);
  if (memory) {
    return memory.members.some((member) => member.identityId === normalizedIdentityId);
  }
  return readSessionMembers(scope, false, (database, sessionKey) =>
    hasSessionMemberInDatabase(database, sessionKey, normalizedIdentityId),
  );
}

export {
  addSessionMemberInWorker as addSessionMember,
  removeSessionMemberInWorker as removeSessionMember,
} from "./session-sharing-store.async.js";
