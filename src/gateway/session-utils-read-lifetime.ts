import { getRuntimeConfig } from "../config/io.js";
import { retainPreparedSessionEntryPredicate } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import type { SessionEntryReadScope } from "../config/sessions/session-accessor.types.js";
import type { SessionActorHotState } from "../config/sessions/session-actor-contract.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
import { assertCapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.js";
import { attachSessionEntrySnapshots } from "../config/sessions/session-entry-snapshot-values.js";
import {
  captureSessionStoreReadCandidate,
  isSessionStoreReadCandidateCurrent,
} from "../config/sessions/session-store-read-candidates.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import { omitInternalSessionEffectsEntries } from "./session-utils-store-selection.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";

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
    prepared?: Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>;
  },
  consume: (
    loaded: Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>,
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
  const loaded = params.prepared ?? (await loadGatewaySessionEntryReadOnlyInWorker(params));
  if (params.prepared && params.excludeInternalEffects) {
    omitInternalSessionEffectsEntries(loaded.store, loaded.storeKeys);
    loaded.entry = loaded.store[loaded.legacyKey ?? loaded.canonicalKey];
  }
  return consume(loaded, () => params.assertActive?.());
}

/** Retain the selected row and physical owner through asynchronous metadata preparation. */
export async function retainGatewaySessionEntryReadOnly(
  sessionKey: string,
  agentId: string | undefined,
  allowMetadataChanges?: (previous: SessionEntry, current: SessionEntry) => boolean,
  cfg: OpenClawConfig = getRuntimeConfig(),
  options: {
    exactRead?: true;
    preserveQualifiedAddress?: true;
    prepared?: Awaited<ReturnType<typeof loadGatewaySessionEntryReadOnlyInWorker>>;
  } = {},
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
      readRetainedEntry: memory.read,
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
  const assertRoutingCurrent = captureSessionMutationRouting(cfg, undefined, [
    { sessionKey, agentId, preserveQualifiedAddress: options.preserveQualifiedAddress },
  ]);
  let released = false;
  let invalidated = false;
  const stopChanges = sessionChanges.subscribeFacts((change) => {
    if ("all" in change || change.sessionKey === sessionKey) {
      invalidated = true;
    }
  });
  let predicate: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  let unregister = () => {};
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    stopChanges();
    predicate?.release();
    unregister();
  };
  try {
    // A caller that already selected a physical source retains that source without discovery.
    const selected =
      options.prepared ??
      (await loadGatewaySessionEntryReadOnlyInWorker({
        cfg,
        key: sessionKey,
        agentId,
        projection: "list",
        exactRead: options.exactRead,
        preserveQualifiedAddress: options.preserveQualifiedAddress,
      }));
    const source = selected.capturedReadSource;
    const selectedPath = captureSessionStoreReadCandidate(selected.storePath);
    if (source && typeof source.databaseIdentity === "string") {
      predicate = retainPreparedSessionEntryPredicate({
        databaseIdentity: `file:${source.databaseIdentity}`,
        sessionKey: selected.legacyKey ?? selected.canonicalKey,
        entry: selected.entry,
        matches: (previous, current) =>
          previous && current
            ? previous.sessionId === current.sessionId &&
              previous.lifecycleRevision === current.lifecycleRevision &&
              (JSON.stringify({ ...previous, lastReadAt: undefined }) ===
                JSON.stringify({ ...current, lastReadAt: undefined }) ||
                allowMetadataChanges?.(previous, current) === true)
            : previous === current,
      });
      unregister = registerOpenClawAgentDatabaseAsyncResource({
        agentId: source.agentId,
        path: source.path,
        revoke: release,
        close: () => Promise.resolve(),
      });
      stopChanges();
    }
    return {
      ...selected,
      readRetainedEntry: () => (predicate ? predicate.readRetainedEntry() : selected.entry),
      isCurrent: () => !released,
      isCurrentAtResponse: () => {
        if (released || (predicate ? !predicate.isCurrent() : invalidated)) {
          return false;
        }
        try {
          if (!isSessionStoreReadCandidateCurrent(selectedPath)) {
            return false;
          }
          assertRoutingCurrent(getRuntimeConfig());
          if (source) {
            assertCapturedSessionEntryReadSource(source);
          }
          return true;
        } catch {
          return false;
        }
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
