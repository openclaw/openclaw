import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../config/sessions/session-entry-source-authority.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import type { WorkerSessionPlacementIdentity } from "./worker-environments/placement-record.js";

export async function prepareWorkerPlacementRepositoryManifestRefs(
  placement: WorkerSessionPlacementIdentity,
): Promise<(() => readonly string[] | null) & Disposable> {
  const memory = getSessionActorStorageBinding(placement);
  const metadata = memory ? undefined : captureSessionEntryMetadataRead(placement);
  const nativeIncognito = !memory && !metadata && isIncognitoSessionKey(placement.sessionKey);
  const scope = { ...placement, storePath: resolveSessionStorePathForScope(placement) };
  let active = true;
  const release = () => {
    active = false;
  };
  try {
    const entry = memory
      ? memory.actor.snapshot(memory.authority)?.entry
      : metadata
        ? metadata.readCurrent()
        : nativeIncognito
          ? loadSessionEntryReadOnly(scope)
          : await readSessionEntryReadOnlyInWorker(scope);
    if (entry?.sessionId !== placement.sessionId) {
      release();
      return Object.assign(() => null, { [Symbol.dispose]: release });
    }
    const prepared = entry.repositoryWorkspaceId
      ? await getSessionRepositoryWorkspaceStore().prepare(entry.repositoryWorkspaceId)
      : undefined;
    return Object.assign(
      () => {
        if (!active) {
          return null;
        }
        if (!prepared) {
          return [];
        }
        try {
          const repository = prepared.current();
          // Conservatively retain the original base if the session changes destinations.
          return repository?.agentId === placement.agentId &&
            repository.sessionKey === placement.sessionKey &&
            repository.baseManifestHash
            ? [repository.baseManifestHash]
            : null;
        } catch {
          // Unsettled or retired repository ownership cannot authorize manifest deletion.
          return null;
        }
      },
      { [Symbol.dispose]: release },
    );
  } catch (error) {
    release();
    throw error;
  }
}
