import path from "node:path";
import { captureSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createOpenClawAgentDatabaseClaim } from "../state/openclaw-agent-db-identity.js";
import {
  agentDatabaseLifecycle,
  isIncognitoOpenClawAgentDatabase,
  retainAgentDatabase,
} from "../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabaseSyncResource } from "../state/openclaw-agent-db-resources.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";

/** Retain source lifetime through the caller's last assertion and publication. */
export async function withControlUiSessionPrSource<T>(
  source: { agentId: string; path: string },
  operation: (assertCurrent: () => void, sourceIdentity: string) => Promise<T>,
): Promise<T> {
  const target = { agentId: normalizeAgentId(source.agentId), path: path.resolve(source.path) };
  const unregister: Array<() => void> = [];
  let active = true;
  let releaseNative = () => {};
  const changed = () => new Error("Session PR source changed or closed. Retry the request.");
  try {
    let paths: string[];
    let assertSource: () => void;
    let sourceIdentity: string;
    if (isIncognitoOpenClawAgentSqlitePath(target.path, target)) {
      // Borrow the already selected native owner without opening or querying SQLite.
      const database = agentDatabaseLifecycle.databases.get(target.path);
      if (
        !database?.db.isOpen ||
        database.agentId !== target.agentId ||
        !isIncognitoOpenClawAgentDatabase(database)
      ) {
        throw changed();
      }
      releaseNative = retainAgentDatabase(database.db);
      const claim = createOpenClawAgentDatabaseClaim(database, releaseNative);
      releaseNative = claim.release;
      sourceIdentity = `incognito:${claim.incarnation}`;
      paths = [target.path];
      assertSource = () => {
        claim.assertCurrent();
        if (
          agentDatabaseLifecycle.databases.get(target.path) !== database ||
          !isIncognitoOpenClawAgentDatabase(database)
        ) {
          throw changed();
        }
      };
    } else {
      const candidate = captureSessionStoreReadCandidate(target.path);
      const identity = readDatabasePathIdentitySync(candidate.path);
      if (!identity.key.startsWith("file:") || identity.canonicalPath !== candidate.physicalPath) {
        throw changed();
      }
      sourceIdentity = identity.key;
      paths = [...new Set([candidate.path, candidate.physicalPath])];
      assertSource = () => {
        const current = readDatabasePathIdentitySync(candidate.path);
        if (current.key !== identity.key || current.canonicalPath !== candidate.physicalPath) {
          throw changed();
        }
      };
    }
    // Both lexical and physical close paths retire this capture before another await can publish.
    for (const pathname of paths) {
      unregister.push(
        registerOpenClawAgentDatabaseSyncResource({
          agentId: target.agentId,
          path: pathname,
          revoke: () => {
            active = false;
          },
          close: () => releaseNative(),
        }),
      );
    }
    const assertCurrent = () => {
      if (!active) {
        throw changed();
      }
      assertSource();
    };
    assertCurrent();
    return await operation(assertCurrent, sourceIdentity);
  } finally {
    active = false;
    for (const release of unregister.toReversed()) {
      release();
    }
    releaseNative();
  }
}
