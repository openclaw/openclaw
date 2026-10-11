import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  captureSessionActorStorageOwner,
  withSessionActorStorage,
} from "./session-actor-storage-binding.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import type { SessionMember } from "./session-membership-facts.types.js";
import {
  hasSessionMemberInDatabase,
  listSessionMembersInDatabase,
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
  const memory = captureSessionActorStorageOwner(scope, { assertCurrent() {}, authorize() {} });
  if (!memory) {
    return undefined;
  }
  const current =
    memory.binding?.agentId === memory.agentId &&
    memory.binding.path === memory.path &&
    scope.sessionKey.trim() === memory.binding.actor.target.sessionKey
      ? memory.binding.actor.snapshot(memory.authority)
      : memory.owner?.readSession(scope.sessionKey, memory.authority);
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
  const memory = captureSessionActorStorageOwner(input, { assertCurrent() {}, authorize() {} });
  if (memory) {
    return (
      (await withSessionActorStorage(
        input,
        {
          authority: memory.authority,
          lifetime: {
            assertCurrent: memory.authority.assertCurrent,
            assertReadable: memory.authority.assertCurrent,
          },
        },
        (binding) =>
          binding.actor.storage.read(
            { type: "session.members.read", input: {} },
            binding.authority,
          ),
      )) ?? { entry: undefined, members: [] }
    );
  }
  const resolved = resolveSqliteScope(input);
  const env = { ...(resolved.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const options = toDatabaseOptions({ ...resolved, env });
  const databasePath = resolveOpenClawAgentSqlitePath(options);
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
