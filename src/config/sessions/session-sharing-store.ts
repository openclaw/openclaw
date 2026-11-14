import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveStateDir } from "../state-dir.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { withSessionActorStorage } from "./session-actor-storage-acquisition.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import type { SessionCollaborationScope } from "./session-collaboration-scope.js";
import { withSessionStoreReaderInWorker } from "./session-entry-read-runtime.js";
import type { SessionMembersSnapshot } from "./session-sharing-store.kernel.js";
import { projectionLane } from "./session-transcript-worker-resources.js";

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
            assertCurrent: () => memory.authority.assertCurrent(),
            assertReadable: () => memory.authority.assertCurrent(),
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

export {
  addSessionMemberInWorker as addSessionMember,
  removeSessionMemberInWorker as removeSessionMember,
} from "./session-sharing-store.async.js";
