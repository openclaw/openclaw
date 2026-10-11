import { getRuntimeConfig } from "../config/io.js";
import { captureSessionEntryRead } from "../config/sessions/session-accessor.sqlite-entry-read-lifetime.js";
import type { SessionEntryReadScope } from "../config/sessions/session-accessor.types.js";
import type { SessionActorHotState } from "../config/sessions/session-actor-contract.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
import { attachSessionEntrySnapshots } from "../config/sessions/session-entry-snapshot-values.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { isOpenClawAgentDatabasePathCurrent } from "../state/openclaw-agent-db-identity.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import {
  findCanonicalStoreMatch,
  omitInternalSessionEffectsEntries,
} from "./session-utils-store-selection.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";

function captureMemoryRead(params: {
  cfg?: OpenClawConfig;
  key: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  projection?: SessionEntryReadScope["projection"];
}) {
  const cfg = params.cfg ?? getRuntimeConfig();
  const { canonicalKey, agentId } = resolveSessionStoreIdentity({
    cfg,
    sessionKey: params.key,
    agentId: params.agentId,
  });
  if (!isIncognitoSessionKey(canonicalKey)) {
    return undefined;
  }
  const captured = captureSessionActorStorageOwner(
    { agentId, sessionKey: canonicalKey, env: params.env },
    { assertCurrent() {}, authorize() {} },
  );
  if (!captured) {
    throw new Error("Incognito session read requires a memory owner selection");
  }
  const { binding, authority, owner, path: storePath } = captured;
  const assertCurrent = () => {
    if (binding) {
      binding.actor.assertReadable();
    } else {
      owner?.assertCurrent();
    }
    authority.assertCurrent();
  };
  const read = () => {
    let snapshot: SessionActorHotState | undefined;
    if (binding?.actor.target.sessionKey === canonicalKey) {
      snapshot = binding.actor.snapshot(authority);
    } else {
      binding?.actor.assertReadable();
      snapshot = owner?.readSession(canonicalKey, authority);
    }
    return snapshot?.entry && attachSessionEntrySnapshots(snapshot.entry, {}, params.projection);
  };
  return {
    assertCurrent,
    read,
    loaded() {
      const entry = read();
      return {
        cfg,
        agentId,
        canonicalKey,
        storePath,
        storeKeys: [canonicalKey],
        store: entry ? { [canonicalKey]: entry } : {},
        entry,
        legacyKey: undefined,
        readSource: { agentId, path: storePath },
      };
    },
  };
}

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
  const memory = captureMemoryRead(params);
  if (memory) {
    const loaded = memory.loaded();
    if (params.excludeInternalEffects) {
      omitInternalSessionEffectsEntries(loaded.store, loaded.storeKeys);
      loaded.entry = loaded.store[loaded.canonicalKey];
    }
    let active = true;
    try {
      return await consume(loaded, () => {
        if (!active) {
          throw new Error("Session entry read is no longer retained");
        }
        params.assertActive?.();
        memory.assertCurrent();
      });
    } finally {
      active = false;
    }
  }
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

/** Retain the selected row and physical owner through asynchronous metadata preparation. */
export function retainGatewaySessionEntryReadOnly(
  sessionKey: string,
  agentId: string,
  allowMetadataChanges?: Parameters<typeof captureSessionEntryRead>[2],
  cfg?: Parameters<typeof loadGatewaySessionEntryReadOnly>[2],
) {
  const memory = captureMemoryRead({ cfg, key: sessionKey, agentId, projection: "list" });
  if (memory) {
    const selected = memory.loaded();
    let released = false;
    const isCurrent = () => {
      if (released) {
        return false;
      }
      try {
        memory.assertCurrent();
        return true;
      } catch {
        return false;
      }
    };
    return {
      ...selected,
      isCurrent,
      isCurrentAtResponse: () => {
        if (released) {
          return false;
        }
        let current: ReturnType<typeof memory.read>;
        try {
          current = memory.read();
        } catch {
          return false;
        }
        const previous = selected.entry;
        if (!previous || !current) {
          return previous === current;
        }
        return (
          previous.sessionId === current.sessionId &&
          previous.lifecycleRevision === current.lifecycleRevision &&
          (JSON.stringify({ ...previous, lastReadAt: undefined }) ===
            JSON.stringify({ ...current, lastReadAt: undefined }) ||
            allowMetadataChanges?.(previous, current) === true)
        );
      },
      release() {
        released = true;
      },
    };
  }
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
