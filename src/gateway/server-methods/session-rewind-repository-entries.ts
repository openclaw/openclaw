import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
} from "../../config/sessions/session-actor-storage-binding.js";
import { withSessionEntriesFromStoresInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureSessionEntryMetadataRead } from "../../config/sessions/session-entry-source-authority.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import type { GatewaySessionEntryRead } from "../session-utils-store.js";

/** Source edits revoke the fork; a changed destination conservatively retains its repository. */
export async function prepareRewindRepositoryEntries(
  source: GatewaySessionEntryRead,
  targetKey: string,
  assertCurrent: () => void,
) {
  const scope = {
    agentId: source.agentId,
    sessionKey: source.canonicalKey,
    storePath: source.storePath,
  };
  const memory = getSessionActorStorageBinding(scope);
  const metadata = captureSessionEntryMetadataRead(scope, assertCurrent);
  const memoryOwner = memory && captureSessionActorStorageOwner(memory);
  if (memory || metadata || isIncognitoSessionKey(source.canonicalKey)) {
    const read = (key: string) => {
      if (memory) {
        return memoryOwner?.owner?.readSession(key, memory.authority)?.entry;
      }
      if (metadata) {
        return key === source.canonicalKey
          ? metadata.readCurrent()
          : captureSessionEntryMetadataRead(
              { ...scope, sessionKey: key },
              assertCurrent,
            )?.readCurrent();
      }
      return undefined;
    };
    return {
      readSource: () => read(source.canonicalKey),
      isForkUnclaimed: (workspaceId: string) =>
        read(targetKey)?.repositoryWorkspaceId !== workspaceId,
      [Symbol.dispose]() {},
    };
  }
  let active = true;
  let databaseIdentity: string | undefined;
  let unregister = () => {};
  const retained = new Map<string, ReturnType<typeof retainPreparedSessionEntryPredicate>>();
  const release = () => {
    active = false;
    for (const predicate of retained.values()) {
      predicate.release();
    }
    unregister();
  };
  try {
    const entries = await withSessionEntriesFromStoresInWorker(
      [{ ...scope, sessionKeys: [source.canonicalKey, targetKey], projection: "list" }],
      ([read]) => {
        assertCurrent();
        const selected = new Map<string, InternalSessionEntry>(
          read!.result.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
        );
        if (!active || !databaseIdentity?.startsWith("file:")) {
          throw new Error("Repository fork session source is unavailable");
        }
        for (const key of [source.canonicalKey, targetKey]) {
          retained.set(
            key,
            retainPreparedSessionEntryPredicate({
              databaseIdentity,
              sessionKey: key,
              entry: selected.get(key),
              matches: (before, after) =>
                before?.sessionId === after?.sessionId &&
                before?.lifecycleRevision === after?.lifecycleRevision &&
                before?.repositoryWorkspaceId === after?.repositoryWorkspaceId,
            }),
          );
        }
        return selected;
      },
      {
        prepareSource: (_input, database, identity) => {
          databaseIdentity = identity.key;
          unregister = registerOpenClawAgentDatabaseAsyncResource({
            ...database,
            revoke: release,
            close: async () => release(),
          });
        },
      },
    );
    return {
      readSource: () => {
        if (!active || !retained.get(source.canonicalKey)?.isCurrent()) {
          throw new Error("Repository fork session owner changed");
        }
        return entries.get(source.canonicalKey);
      },
      isForkUnclaimed: (workspaceId: string) =>
        active &&
        retained.get(targetKey)?.isCurrent() === true &&
        entries.get(targetKey)?.repositoryWorkspaceId !== workspaceId,
      [Symbol.dispose]: release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
