import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  createOpenClawAgentDatabaseClaim,
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
  type OpenClawAgentDatabaseClaim,
} from "../../state/openclaw-agent-db-identity.js";
import {
  borrowOpenClawAgentDatabase,
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentSqlitePath,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAsync,
} from "../../state/openclaw-agent-db.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../paths.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

/** Admission retains the exact owner that supplied its row across asynchronous policy work. */
export async function loadSessionEntryForAdmission(
  scope: SessionAccessScope,
  preparation: {
    signal?: AbortSignal;
    assertCurrent?: () => void;
  } = {},
): Promise<{ entry: SessionEntry | undefined; databaseClaim: OpenClawAgentDatabaseClaim }> {
  const resolved = resolveSqliteScope(scope);
  const options = toDatabaseOptions(resolved);
  options.env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  options.env.OPENCLAW_STATE_DIR = resolveStateDir(options.env);
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  options.path = databasePath;
  const incognito = isIncognitoOpenClawAgentSqlitePath(databasePath, options);
  const assertCurrent = () => {
    preparation.signal?.throwIfAborted();
    preparation.assertCurrent?.();
  };
  assertCurrent();
  const capture = () => {
    assertCurrent();
    const database = openOpenClawAgentDatabase(options);
    const borrowed = borrowOpenClawAgentDatabase(options);
    return {
      database,
      databaseClaim: createOpenClawAgentDatabaseClaim(database, borrowed.release),
    };
  };
  let captured: ReturnType<typeof capture>;
  if (getOpenClawAgentDatabaseIfOpen(options) || incognito) {
    captured = capture();
  } else {
    // Shared bootstrap opens once; each waiter retains its own cancellation and claim.
    const identity = readDatabasePathIdentitySync(databasePath);
    const assertOpening = () => {
      // Shared bootstrap owns only this physical file; each caller guards its own result.
      const current = readDatabasePathIdentitySync(databasePath);
      if (
        identity.key.startsWith("file:")
          ? current.key !== identity.key
          : current.canonicalPath !== identity.canonicalPath
      ) {
        throw new Error("Session database changed while waiting for admission");
      }
    };
    captured = await withOpenClawAgentDatabaseAsync(
      options,
      capture,
      assertOpening,
      preparation.signal,
    );
  }
  const { database, databaseClaim } = captured;
  try {
    if (incognito) {
      return { entry: readSessionEntryRow(database, resolved.sessionKey)?.entry, databaseClaim };
    }
    const { withSessionHistoryWorkerDatabase } =
      await import("./session-transcript-worker-runtime.js");
    assertCurrent();
    const result = await withSessionHistoryWorkerDatabase(options, (owner) => {
      assertCurrent();
      return owner.readExactEntries(
        {
          sessionKeys: [resolved.sessionKey],
          env: options.env!,
          includeAuthorization: true,
        },
        preparation.signal,
      );
    });
    assertCurrent();
    databaseClaim.assertCurrent();
    const physical = readOpenClawAgentDatabaseIdentity(database);
    if (
      result.databaseIdentity?.identity !== physical.identity ||
      result.databaseIdentity.birthtime !== physical.birthtime ||
      !isOpenClawAgentDatabasePathCurrent(database)
    ) {
      throw new Error("Session database changed during admission read");
    }
    return { entry: result.entries[0]?.entry, databaseClaim };
  } catch (error) {
    databaseClaim.release();
    throw error;
  }
}
