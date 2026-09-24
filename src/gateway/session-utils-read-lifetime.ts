import { captureSessionEntryRead } from "../config/sessions/session-accessor.sqlite-entry-read-lifetime.js";
import { isOpenClawAgentDatabasePathCurrent } from "../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

/** Retain the selected row and physical owner through asynchronous metadata preparation. */
export function retainGatewaySessionEntryReadOnly(
  sessionKey: string,
  agentId: string,
  allowMetadataChanges?: Parameters<typeof captureSessionEntryRead>[2],
) {
  const options = { agentId, projection: "list" as const };
  const selected = loadGatewaySessionEntryReadOnly(sessionKey, options);
  let released = false;
  const sameRoute = () => {
    const current = loadGatewaySessionEntryReadOnly(sessionKey, options);
    return (
      current.agentId === selected.agentId &&
      current.canonicalKey === selected.canonicalKey &&
      current.legacyKey === selected.legacyKey &&
      current.storePath === selected.storePath &&
      current.readSource?.agentId === selected.readSource?.agentId &&
      current.readSource?.path === selected.readSource?.path
    );
  };
  if (!selected.readSource) {
    // A missing saved session has no private selection and must stay absent until publication.
    return {
      ...selected,
      isCurrent: () => !released,
      isCurrentAtResponse: () =>
        !released &&
        sameRoute() &&
        loadGatewaySessionEntryReadOnly(sessionKey, options).entry === undefined,
      release: () => {
        released = true;
      },
    };
  }
  const retained = retainOpenClawAgentDatabaseReadOnly(selected.readSource);
  if (!retained.found) {
    throw new Error("Session store changed while preparing its metadata. Retry the request.");
  }
  const { database, claim } = retained;
  let entryRead: ReturnType<typeof captureSessionEntryRead> | undefined;
  let unregister = () => {};
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    unregister();
    entryRead?.release();
    claim.release();
  };
  try {
    entryRead = captureSessionEntryRead(
      database,
      selected.legacyKey ?? selected.canonicalKey,
      allowMetadataChanges,
    );
    const read = entryRead;
    unregister = registerOpenClawAgentDatabaseAsyncResource({
      agentId: database.agentId,
      path: database.path,
      revoke: release,
      // Metadata holds no asynchronous database operation or write to settle.
      close: () => Promise.resolve(),
    });
    return {
      ...selected,
      entry: read.entry,
      // Catalog projection calls this per model; exact target reads belong at publication.
      isCurrent: () => !released && claim.isCurrent(),
      // Re-read canonical target facts and verify physical ownership before publishing.
      isCurrentAtResponse: () =>
        !released &&
        claim.isCurrent() &&
        read.isCurrent() &&
        isOpenClawAgentDatabasePathCurrent(database) &&
        sameRoute(),
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
