import type { SessionEntryReadSource } from "../config/sessions/session-accessor.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { selectStoredSessionLineage } from "./session-store-key.js";
import {
  readGatewayStoredSessionEntry,
  resolveGatewaySessionStoreTargetWithStore,
  type GatewaySessionStoreDiscoveryCache,
} from "./session-utils-store-lookup.js";
import { readGatewaySessionStore } from "./session-utils-store-read.js";

/** Stored-address joins share discovery without passing selected keys through request aliases. */
export function createGatewaySessionLineageReader(cfg: OpenClawConfig) {
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  function readAlias(key: string, agentId: string) {
    const target = resolveGatewaySessionStoreTargetWithStore({
      cfg,
      key,
      ...(parseAgentSessionKey(key) ? {} : { agentId }),
      readOnly: true,
      exactRead: true,
      clone: false,
      projection: "list",
      targetDiscoveryCache,
    });
    return target.store[target.canonicalKey];
  }
  const readStored = (agentId: string, key: string): SessionEntry | undefined => {
    if (isIncognitoSessionKey(key)) {
      return readAlias(key, agentId);
    }
    return readGatewayStoredSessionEntry({
      cfg,
      agentId,
      key,
      targetDiscoveryCache,
    });
  };
  return { readStored, readAlias };
}

/** Exact row owners supply missing parent facts without expanding their selected store. */
export function createGatewaySessionEntryReader(params: {
  cfg: OpenClawConfig;
  agentId: string;
  store: Record<string, SessionEntry>;
  readSource?: SessionEntryReadSource;
}): (key: string) => SessionEntry | undefined {
  const reader = createGatewaySessionLineageReader(params.cfg);
  return (key) => {
    if (params.store[key]) {
      return params.store[key];
    }
    if (key === "global" || key === "unknown") {
      const readSource = params.readSource;
      if (!readSource) {
        return undefined;
      }
      return readGatewaySessionStore({
        agentId: readSource.agentId,
        storePath: readSource.path,
        options: { readSource, readOnly: true, exactKeys: [key], projection: "list" },
      })[key];
    }
    return selectStoredSessionLineage({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: key,
      read: reader.readStored,
      readAlias: () => reader.readAlias(key, params.agentId),
    }).value;
  };
}
