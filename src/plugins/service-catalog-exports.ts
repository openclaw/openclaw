import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  SessionCatalogHost,
  SessionCatalogLocator,
  SessionCatalogSession,
  SessionCatalogTranscriptItem,
} from "../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { resolveSessionAgentIdsStrict } from "../agents/agent-scope.js";
import { allowsProcessHomeSessionScan } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.js";
import { truncateUtf16Safe } from "../utils.js";
import type { PluginRegistry } from "./registry-types.js";

type CatalogExportSession = Pick<
  SessionCatalogSession,
  | "threadId"
  | "sourceHomeId"
  | "exportPolicy"
  | "name"
  | "recencyAt"
  | "updatedAt"
  | "modelProvider"
>;
type CatalogExportHost = Pick<
  SessionCatalogHost,
  "hostId" | "kind" | "connected" | "error" | "nextCursor"
> & { sessions: CatalogExportSession[] };
export type CatalogExportItem = Pick<
  SessionCatalogTranscriptItem,
  "type" | "model" | "text" | "truncated"
> & { speakerId?: string };

export type PluginServiceExportCatalog = {
  id: string;
  processHomeFallbackAllowed: boolean;
  list(params: { agentId?: string; limitPerHost?: number }): Promise<CatalogExportHost[]>;
  read(
    params: Omit<SessionCatalogLocator, "catalogId"> & { limit: number; cursor?: string },
  ): Promise<{ hostId: string; threadId: string; items: CatalogExportItem[]; nextCursor?: string }>;
};

export type PluginServiceCatalogExports = { listCatalogs(): PluginServiceExportCatalog[] };

function readAllowedIds(
  config: OpenClawConfig,
  pluginId: string,
  path: readonly string[],
): Set<string> {
  const entry = config.plugins?.entries?.[pluginId];
  if (!entry || entry.enabled === false || !path.length) {
    return new Set();
  }
  let value: unknown = entry.config;
  for (const part of path) {
    if (!isRecord(value) || !Object.hasOwn(value, part)) {
      return new Set();
    }
    value = value[part];
  }
  return new Set(
    Array.isArray(value)
      ? value.flatMap((id) => (typeof id === "string" ? [id.trim().toLowerCase()] : []))
      : [],
  );
}

function projectItem(item: SessionCatalogTranscriptItem): CatalogExportItem {
  if (item.type !== "userMessage" && item.type !== "agentMessage") {
    return { type: item.type, ...(item.truncated ? { truncated: true } : {}) };
  }
  const text = item.text && truncateUtf16Safe(item.text, 16_384);
  // A conversation-local exporter needs equality, never profile names or account identifiers.
  const speakerId = item.sender
    ? createHash("sha256").update(JSON.stringify(item.sender.identity)).digest("hex")
    : undefined;
  return {
    type: item.type,
    ...(text ? { text } : {}),
    ...(item.model ? { model: truncateUtf16Safe(item.model, 256) } : {}),
    ...(speakerId ? { speakerId } : {}),
    ...(item.truncated || text !== item.text ? { truncated: true } : {}),
  };
}

export function createPluginServiceCatalogExports(params: {
  pluginId: string;
  configPath: readonly string[];
  registry: Pick<PluginRegistry, "sessionCatalogs">;
  signal: AbortSignal;
  assertActive(): void;
  getConfig(): OpenClawConfig | undefined;
}): PluginServiceCatalogExports {
  const configPath = [...params.configPath];
  let generation = 0;
  return {
    listCatalogs() {
      const admitted = ++generation;
      params.assertActive();
      params.signal.throwIfAborted();
      const config = params.getConfig();
      if (!config) {
        return [];
      }
      const ids = readAllowedIds(config, params.pluginId, configPath);
      const { defaultAgentId: agentId } = resolveSessionAgentIdsStrict({ config });
      const allowProcessHomeFallback = allowsProcessHomeSessionScan();
      return params.registry.sessionCatalogs.flatMap((entry): PluginServiceExportCatalog[] => {
        const { provider } = entry;
        const localHosts = provider.automaticExportHosts;
        if (
          !ids.has(provider.id) ||
          entry.pluginId === params.pluginId ||
          !localHosts ||
          (!allowProcessHomeFallback && !provider.supportsProcessHomeIsolation)
        ) {
          return [];
        }
        const assertCurrent = (requestedAgentId?: string) => {
          params.signal.throwIfAborted();
          params.assertActive();
          if (
            admitted !== generation ||
            (requestedAgentId !== undefined && requestedAgentId !== agentId) ||
            params.getConfig() !== config ||
            !readAllowedIds(config, params.pluginId, configPath).has(provider.id) ||
            !params.registry.sessionCatalogs.includes(entry)
          ) {
            throw new Error("Catalog export grant expired; list sources again");
          }
        };
        const key = (hostId: string, threadId: string, sourceHomeId?: string) =>
          JSON.stringify([hostId, threadId, sourceHomeId ?? null]);
        let latest = new Set<string>();
        return [
          {
            id: provider.id,
            processHomeFallbackAllowed: allowProcessHomeFallback,
            async list(request) {
              assertCurrent(request.agentId);
              // Publishing a newer list retires grants and pending reads from the preceding one.
              const selected = new Set<string>();
              latest = selected;
              const hosts = new Set(await localHosts({ agentId, allowProcessHomeFallback }));
              assertCurrent(request.agentId);
              if (!hosts.size) {
                return [];
              }
              const listed = await provider.list({
                agentId,
                allowProcessHomeFallback,
                hostIds: [...hosts],
                listNodes: async () => ({ nodes: [] }),
                limitPerHost: Math.min(Math.max(1, request.limitPerHost ?? 50), 100),
                signal: params.signal,
              });
              assertCurrent(request.agentId);
              if (selected !== latest) {
                throw new Error("Catalog listing superseded");
              }
              return listed.flatMap((host): CatalogExportHost[] => {
                if (
                  !hosts.has(host.hostId) ||
                  host.kind !== "gateway" ||
                  !host.connected ||
                  host.error
                ) {
                  return [];
                }
                const origins = new Map<string, string | undefined>();
                const collisions = new Set<string>();
                for (const row of host.sessions) {
                  if (origins.has(row.threadId) && origins.get(row.threadId) !== row.sourceHomeId) {
                    collisions.add(row.threadId);
                  }
                  origins.set(row.threadId, row.sourceHomeId);
                }
                const sessions = host.sessions.flatMap((row): CatalogExportSession[] => {
                  if (
                    collisions.has(row.threadId) ||
                    row.exportPolicy?.origin !== "native-local" ||
                    !row.exportPolicy.automatic
                  ) {
                    return [];
                  }
                  selected.add(key(host.hostId, row.threadId, row.sourceHomeId));
                  return [
                    {
                      threadId: row.threadId,
                      sourceHomeId: row.sourceHomeId,
                      exportPolicy: row.exportPolicy,
                      name: row.name && truncateUtf16Safe(row.name, 512),
                      modelProvider: row.modelProvider,
                      updatedAt: row.updatedAt,
                      recencyAt: row.recencyAt,
                    },
                  ];
                });
                return [
                  {
                    hostId: host.hostId,
                    kind: host.kind,
                    connected: true,
                    nextCursor: host.nextCursor,
                    sessions,
                  },
                ];
              });
            },
            async read(request) {
              assertCurrent(request.agentId);
              const granted = latest;
              const permitted = key(request.hostId, request.threadId, request.sourceHomeId);
              if (
                !granted.has(permitted) ||
                !Number.isInteger(request.limit) ||
                request.limit < 1 ||
                request.limit > 50
              ) {
                throw new Error("Select a listed local source and request at most 50 items");
              }
              const page = await provider.read({
                hostId: request.hostId,
                threadId: request.threadId,
                sourceHomeId: request.sourceHomeId,
                agentId,
                allowProcessHomeFallback,
                limit: request.limit,
                cursor: request.cursor,
              });
              assertCurrent(request.agentId);
              if (
                latest !== granted ||
                page.hostId !== request.hostId ||
                page.threadId !== request.threadId ||
                page.items.length > request.limit
              ) {
                throw new Error("Catalog source changed during export");
              }
              return {
                hostId: page.hostId,
                threadId: page.threadId,
                nextCursor: page.nextCursor,
                items: page.items.map(projectItem),
              };
            },
          },
        ];
      });
    },
  };
}
