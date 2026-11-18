import { resolveSessionConfiguredDefault } from "../agents/session-model-ref.js";
import { resolveSessionParentSessionKey } from "../channels/plugins/session-conversation.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { resolveDirectStoredModelOverride } from "../sessions/stored-model-overrides.js";
import {
  resolveStoredSessionKeyForAgentStore,
  selectStoredSessionLineage,
} from "./session-store-key.js";
import type { GatewaySessionStoreDiscoveryCache } from "./session-utils-store-candidates.js";
import { resolveGatewaySessionStoreTargetWithStoreAsync } from "./session-utils-store-lookup.js";

/** Prepare ordinary stored lineage through the existing Gateway worker owner. */
export function createGatewaySessionLineageReaderAsync(cfg: OpenClawConfig) {
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  const read = async (agentId: string, key: string, preserveQualifiedAddress: boolean) => {
    const target = await resolveGatewaySessionStoreTargetWithStoreAsync({
      cfg,
      key,
      ...(parseAgentSessionKey(key) ? {} : { agentId }),
      preserveQualifiedAddress,
      readOnly: true,
      exactRead: true,
      clone: false,
      projection: "list",
      targetDiscoveryCache,
    });
    return target.store[target.canonicalKey];
  };
  return {
    readStored: (agentId: string, key: string) => read(agentId, key, true),
    readAlias: (key: string, agentId: string) => read(agentId, key, false),
  };
}

/** A model selection consumes its one prepared parent without synchronous fallback reads. */
export async function prepareGatewaySessionEntryReader(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  entry?: SessionEntry;
  store: Record<string, SessionEntry>;
  readSource?: SessionEntryReadSource;
}): Promise<(key: string) => SessionEntry | undefined> {
  if (
    params.entry?.modelOverrideSource === "default" ||
    resolveDirectStoredModelOverride({
      sessionEntry: params.entry,
      defaultProvider: resolveSessionConfiguredDefault(params.cfg, params.agentId).provider,
    })
  ) {
    return (key) => params.store[key];
  }
  const explicitParent = params.entry?.parentSessionKey?.trim();
  const parentKey =
    explicitParent && explicitParent !== params.sessionKey
      ? explicitParent
      : resolveSessionParentSessionKey(params.sessionKey);
  const prepared = new Map<string, SessionEntry | undefined>();
  if (parentKey && parentKey !== params.sessionKey && !params.store[parentKey]) {
    if (parentKey === "global" || parentKey === "unknown") {
      const source =
        params.readSource ??
        (
          await resolveGatewaySessionStoreTargetWithStoreAsync({
            cfg: params.cfg,
            agentId: params.agentId,
            key: params.sessionKey,
            readOnly: true,
            exactRead: true,
          })
        ).readSource;
      if (source) {
        const rows = await readSessionEntriesFromStoreInWorker({
          agentId: source.agentId,
          storePath: source.path,
          sessionKeys: [parentKey],
          snapshotFields: [],
        });
        prepared.set(parentKey, rows.entries.find((row) => row.sessionKey === parentKey)?.entry);
      }
    } else {
      const reader = createGatewaySessionLineageReaderAsync(params.cfg);
      const owner = normalizeAgentId(parseAgentSessionKey(parentKey)?.agentId ?? params.agentId);
      const storedKey = resolveStoredSessionKeyForAgentStore({
        cfg: params.cfg,
        agentId: owner,
        sessionKey: parentKey,
        preserveQualifiedAddress: true,
      });
      const stored = await reader.readStored(owner, storedKey);
      const alias =
        stored === undefined && !isIncognitoSessionKey(storedKey)
          ? await reader.readAlias(parentKey, params.agentId)
          : undefined;
      const selected = selectStoredSessionLineage({
        cfg: params.cfg,
        agentId: params.agentId,
        sessionKey: parentKey,
        read: () => stored,
        readAlias: () => alias,
      });
      prepared.set(parentKey, selected.value);
    }
  }
  return (key) => params.store[key] ?? prepared.get(key);
}
