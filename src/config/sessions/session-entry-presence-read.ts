import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveStateDir } from "../state-dir.js";
import { captureMemoryExactSessionReader } from "./session-accessor.memory-exact-read.js";
import {
  resolveSqliteScope,
  resolveSqliteSessionKey,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type { SessionRowPresenceWorkerInput } from "./session-transcript-worker.types.js";

/** Capture the exact metadata owner before initial-writer admission can wait. */
export function prepareSessionEntryPresenceRead(input: SessionAccessScope): Readonly<{
  sessionKey: string;
  storePath: string;
  read: () => Promise<boolean>;
}> {
  const memory = captureMemoryExactSessionReader(input);
  if (memory) {
    const sessionKey = resolveSqliteSessionKey(input.sessionKey, memory.agentId);
    const scope = {
      agentId: memory.agentId,
      storePath: memory.path,
      sessionKey,
      sessionActor: getSessionActorStorageBinding({}),
    };
    return {
      sessionKey,
      storePath: memory.path,
      // Presence is reusable; observe the current owner at the captured location each time.
      read: async () => Boolean(captureMemoryExactSessionReader(scope)?.read(sessionKey)),
    };
  }
  const env = { ...(input.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const storePath = resolveSessionStorePathForScope({ ...input, env });
  const resolved = resolveSqliteScope({ ...input, storePath, env });
  const options = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  const scope: SessionRowPresenceWorkerInput["scope"] = {
    agentId: resolved.agentId,
    sessionKey: resolved.sessionKey,
    storePath: databasePath,
    databaseAgentId: options.agentId,
    env,
  };
  return {
    sessionKey: resolved.sessionKey,
    storePath,
    read: async () =>
      await withSessionHistoryWorkerDatabase(
        options,
        async (owner) => await owner.readEntryPresence(scope),
      ),
  };
}
