import { captureSessionEntryRead } from "../config/sessions/session-accessor.sqlite-entry-read-lifetime.js";
import type { SessionEntryReadScope } from "../config/sessions/session-accessor.types.js";
import { captureIncognitoSessionSource } from "../config/sessions/session-incognito-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isOpenClawAgentDatabasePathCurrent } from "../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import {
  findCanonicalStoreMatch,
  omitInternalSessionEffectsEntries,
} from "./session-utils-store-selection.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

/** Full planning rows stay with their consumer; only the actor owns current effect metadata. */
export async function withGatewaySessionEntryReadOnly<T>(
  params: {
    cfg: OpenClawConfig;
    key: string;
    agentId?: string;
    env?: NodeJS.ProcessEnv;
    assertActive?: () => void;
    excludeInternalEffects?: boolean;
    projection?: SessionEntryReadScope["projection"];
  },
  consume: (
    loaded: ReturnType<typeof loadGatewaySessionEntryReadOnly>,
    assertCurrent: () => void,
  ) => Promise<T>,
): Promise<T> {
  const binding = captureIncognitoSessionSource({
    agentId: params.agentId,
    sessionKey: params.key,
    env: params.env,
  });
  if (!binding) {
    const loaded = loadGatewaySessionEntryReadOnly(
      params.key,
      { agentId: params.agentId, env: params.env, projection: params.projection },
      params.cfg,
    );
    if (params.excludeInternalEffects) {
      omitInternalSessionEffectsEntries(loaded.store, loaded.storeKeys);
      loaded.entry = findCanonicalStoreMatch(loaded.store, loaded.storeKeys)?.entry;
    }
    return consume(loaded, () => params.assertActive?.());
  }
  const { agentId, canonicalKey } = resolveSessionStoreIdentity({
    cfg: params.cfg,
    sessionKey: params.key,
    agentId: params.agentId,
  });
  const owner = "kind" in binding ? binding : binding.actor;
  captureIncognitoSessionSource({
    agentId,
    sessionKey: canonicalKey,
    storePath: owner.path,
    env: params.env,
  });
  const assertCurrent = () => {
    params.assertActive?.();
    binding.admissionSignal?.throwIfAborted();
    if ("kind" in binding) {
      binding.assertCurrent();
    } else {
      binding.actor.assertReadable();
    }
  };
  const run = async () => {
    assertCurrent();
    const entry =
      "kind" in binding
        ? undefined
        : (
            await binding.actor.sessions.read(
              { assertCurrent },
              { sessionKey: canonicalKey },
              binding.admissionSignal,
            )
          ).entry;
    assertCurrent();
    const store = entry ? { [canonicalKey]: entry } : {};
    if (params.excludeInternalEffects) {
      omitInternalSessionEffectsEntries(store, [canonicalKey]);
    }
    const result = await consume(
      {
        cfg: params.cfg,
        agentId,
        canonicalKey,
        storePath: owner.path,
        storeKeys: [canonicalKey],
        store,
        entry: store[canonicalKey],
        legacyKey: undefined,
        readSource: { agentId, path: owner.path },
      },
      assertCurrent,
    );
    assertCurrent();
    return result;
  };
  return "kind" in binding ? run() : binding.actor.sessions.withSharedState(run);
}

/** Retain the selected row and physical owner through asynchronous metadata preparation. */
export function retainGatewaySessionEntryReadOnly(
  sessionKey: string,
  agentId: string,
  allowMetadataChanges?: Parameters<typeof captureSessionEntryRead>[2],
  cfg?: Parameters<typeof loadGatewaySessionEntryReadOnly>[2],
) {
  const options = { agentId, projection: "list" as const };
  const selected = loadGatewaySessionEntryReadOnly(sessionKey, options, cfg);
  let released = false;
  const sameRoute = () => {
    const current = loadGatewaySessionEntryReadOnly(sessionKey, options, cfg);
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
        loadGatewaySessionEntryReadOnly(sessionKey, options, cfg).entry === undefined,
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
