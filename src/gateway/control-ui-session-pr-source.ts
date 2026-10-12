import path from "node:path";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import { captureSessionStoreReadCandidate } from "../config/sessions/session-store-read-candidates.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { registerOpenClawAgentDatabaseSyncResource } from "../state/openclaw-agent-db-resources.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";

/** Retain source lifetime through the caller's last assertion and publication. */
export async function withControlUiSessionPrSource<T>(
  source: { agentId: string; path: string },
  operation: (assertCurrent: () => void, sourceIdentity: string) => Promise<T>,
): Promise<T> {
  const target = { agentId: normalizeAgentId(source.agentId), path: path.resolve(source.path) };
  const selected = getSessionActorStorageBinding({
    agentId: target.agentId,
    storePath: target.path,
  });
  if (selected) {
    const assertCurrent = () => {
      selected.authority.assertCurrent();
      selected.actor.assertReadable();
    };
    return operation(assertCurrent, JSON.stringify(selected.actor.target.database));
  }
  const unregister: Array<() => void> = [];
  let active = true;
  const changed = () => new Error("Session PR source changed or closed. Retry the request.");
  try {
    if (isIncognitoOpenClawAgentSqlitePath(target.path, target)) {
      const assertActive = () => {
        if (!active) {
          throw changed();
        }
      };
      const captured = captureSessionActorStorageOwner(
        { agentId: target.agentId, storePath: target.path },
        { assertCurrent: assertActive, authorize: assertActive },
      );
      const owner = captured?.owner;
      if (!captured || !owner) {
        throw changed();
      }
      const assertCurrent = () => {
        captured.authority.assertCurrent();
        owner.assertCurrent();
      };
      assertCurrent();
      return await operation(assertCurrent, JSON.stringify(owner.identity));
    }
    const candidate = captureSessionStoreReadCandidate(target.path);
    const identity = readDatabasePathIdentitySync(candidate.path);
    if (!identity.key.startsWith("file:") || identity.canonicalPath !== candidate.physicalPath) {
      throw changed();
    }
    const sourceIdentity = identity.key;
    const paths = [...new Set([candidate.path, candidate.physicalPath])];
    const assertSource = () => {
      const current = readDatabasePathIdentitySync(candidate.path);
      if (current.key !== identity.key || current.canonicalPath !== candidate.physicalPath) {
        throw changed();
      }
    };
    // Both lexical and physical close paths retire this capture before another await can publish.
    for (const pathname of paths) {
      unregister.push(
        registerOpenClawAgentDatabaseSyncResource({
          agentId: target.agentId,
          path: pathname,
          revoke: () => {
            active = false;
          },
          close: () => {
            active = false;
          },
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
  }
}
