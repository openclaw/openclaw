import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../paths.js";
import { assertCapturedSessionEntryReadSource } from "./session-accessor.sqlite-exact-read.js";
import { toDatabaseOptions, type ResolvedSqliteScope } from "./session-accessor.sqlite-scope.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import { captureIncognitoSessionBinding } from "./session-incognito-binding.js";

/** Bind entry preparation and commit checks to the original physical store before yielding. */
export function captureSessionEntryPatchSource(
  scope: ResolvedSqliteScope,
  sessionKey: string,
  captured?: CapturedSessionEntryReadSource,
) {
  // Queueing and either cold open must retain the same registration and lease owner.
  const resolved = {
    ...scope,
    env: cloneEnvWithPlatformSemantics(scope.env ?? process.env),
  };
  resolved.env.OPENCLAW_STATE_DIR = resolveStateDir(resolved.env);
  const databaseOptions = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(databaseOptions);
  const targetIdentity = readDatabasePathIdentitySync(databasePath);
  resolved.path = databasePath;
  databaseOptions.path = databasePath;
  const incognito = isIncognitoOpenClawAgentSqlitePath(databasePath, databaseOptions);
  const incognitoBinding = captureIncognitoSessionBinding({
    agentId: databaseOptions.agentId,
    env: resolved.env,
    sessionKey,
    storePath: databasePath,
  });
  const assertCapturedSource = (database?: OpenClawAgentDatabase) => {
    if (!captured) {
      return;
    }
    if (incognitoBinding) {
      const { actor } = incognitoBinding;
      actor.assertCurrent();
      if (
        captured.agentId !== actor.agentId ||
        captured.path !== actor.path ||
        captured.databaseIdentity !== actor.identity.incarnation ||
        captured.databaseBirthtime !== undefined
      ) {
        throw new Error("Captured session database changed before entry patch");
      }
      return;
    }
    if (!database && typeof captured.databaseIdentity === "string") {
      assertExistingDatabaseIdentity(
        captured.path,
        `file:${captured.databaseIdentity}`,
        captured.databaseBirthtime,
      );
    }
    assertCapturedSessionEntryReadSource(
      captured,
      database ?? getOpenClawAgentDatabaseIfOpen(databaseOptions),
    );
  };
  const assertCurrent = () => {
    if (targetIdentity.key.startsWith("file:")) {
      assertExistingDatabaseIdentity(databasePath, targetIdentity.key, targetIdentity.birthtime);
    }
    assertCapturedSource();
  };
  return {
    resolved,
    databaseOptions,
    databasePath,
    targetIdentity,
    incognito,
    incognitoBinding,
    assertCapturedSource,
    assertCurrent,
  };
}
