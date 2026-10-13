import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveStateDir } from "../state-dir.js";
import { loadSessionEntryReadOnlyInScope } from "./session-accessor.sqlite-exact-read.js";
import {
  resolveSqliteScope,
  resolveSqliteSessionKey,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import {
  captureIncognitoSessionSource,
  withIncognitoSessionEntry,
} from "./session-incognito-binding.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type { SessionRowPresenceWorkerInput } from "./session-transcript-worker.types.js";

/** Capture the exact metadata owner before initial-writer admission can wait. */
export function prepareSessionEntryPresenceRead(input: SessionAccessScope): Readonly<{
  sessionKey: string;
  storePath: string;
  read: () => Promise<boolean>;
}> {
  const binding = captureIncognitoSessionSource(input);
  if (binding) {
    const owner = "kind" in binding ? binding : binding.actor;
    const storePath = owner.path;
    const sessionKey = resolveSqliteSessionKey(input.sessionKey, owner.agentId);
    return {
      sessionKey,
      storePath,
      read: () =>
        withIncognitoSessionEntry(
          binding,
          sessionKey,
          () => {},
          async (entry) => Boolean(entry),
        ),
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
  const incognito = isIncognitoOpenClawAgentSqlitePath(databasePath, options);
  return {
    sessionKey: resolved.sessionKey,
    storePath,
    read: incognito
      ? async () => loadSessionEntryReadOnlyInScope({ ...scope, projection: "list" }) !== undefined
      : async () =>
          await withSessionHistoryWorkerDatabase(
            options,
            async (owner) => await owner.readEntryPresence(scope),
          ),
  };
}
