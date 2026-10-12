import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionCatalogSession,
  SessionsCatalogReadResult,
} from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { importSessionCatalogHistory } from "./session-catalog-history-import.js";
import {
  listAdoptedSessionCatalogSessions,
  sessionCatalogAdoptedSessionKey,
  type SessionCatalogEntrySnapshot,
} from "./session-catalog.js";
import type { OpenClawPluginApi } from "./types.js";

/** Adopt a native ACP catalog session while keeping its plugin-owned marker shape. */
export function createAcpSessionCatalogAdoption(options: {
  api: OpenClawPluginApi;
  config: () => OpenClawConfig;
  catalogId: string;
  hostId: string;
  keyPrefix: string;
  markerPluginId: string;
  markerKey: string;
  read: (params: {
    threadId: string;
    cursor?: string;
    limit: number;
  }) => Promise<SessionsCatalogReadResult>;
}) {
  const config = options.config;
  return {
    listAdopted: (agentId?: string, sessionEntries?: SessionCatalogEntrySnapshot) => {
      return listAdoptedSessionCatalogSessions({
        ...(agentId ? { agentId } : {}),
        config: config(),
        pluginId: options.api.id,
        runtime: options.api.runtime,
        sessionEntries,
        sourceFromEntry: (entry) => {
          const extension = entry.pluginExtensions?.[options.markerPluginId];
          const marker = isRecord(extension) ? extension[options.markerKey] : undefined;
          return isRecord(marker) && typeof marker.sourceThreadId === "string"
            ? { hostId: options.hostId, threadId: marker.sourceThreadId }
            : undefined;
        },
      });
    },
    create: async (params: {
      agentId: string;
      threadId: string;
      session: SessionCatalogSession;
    }) => {
      const cfg = config();
      const pluginExtensions = {
        [options.markerPluginId]: {
          [options.markerKey]: { sourceThreadId: params.threadId },
        },
      };
      const created = await options.api.runtime.agent.session.createSessionEntry({
        cfg,
        key: sessionCatalogAdoptedSessionKey(options.keyPrefix, params.threadId),
        agentId: params.agentId,
        recoverMatchingInitialEntry: true,
        ...(params.session.name ? { displayName: params.session.name } : {}),
        ...(params.session.cwd ? { spawnedCwd: params.session.cwd } : {}),
        initialEntry: {
          acpBackendId: "acpx",
          acpSessionBinding: { acpAgentId: options.catalogId, agentSessionId: params.threadId },
          pluginExtensions,
        },
        afterCreate: async (entry) => {
          await importSessionCatalogHistory({
            catalogId: options.catalogId,
            threadId: params.threadId,
            read: ({ cursor, limit }) =>
              options.read({ threadId: params.threadId, limit, ...(cursor ? { cursor } : {}) }),
            sessionId: entry.sessionId,
            sessionKey: entry.key,
            agentId: entry.agentId,
            ...(params.session.cwd ? { cwd: params.session.cwd } : {}),
            config: cfg,
          });
          return { pluginExtensions };
        },
      });
      return { sessionKey: created.key };
    },
  };
}
