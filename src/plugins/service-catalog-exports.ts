import { createHmac, randomBytes } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeCatalogTimestamp } from "../../packages/gateway-protocol/src/public-session-catalog.js";
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
  /** Revalidate the selected row immediately before a protected effect. */
  assertCurrent(locator: Omit<SessionCatalogLocator, "catalogId">): void;
  list(params: {
    agentId?: string;
    limitPerHost?: number;
    cursors?: Record<string, string>;
    source?: Pick<SessionCatalogLocator, "hostId" | "threadId" | "sourceHomeId">;
  }): Promise<CatalogExportHost[]>;
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

function projectItem(
  item: SessionCatalogTranscriptItem,
  salt: Buffer,
  sourceKey: string,
): CatalogExportItem {
  if (item.type !== "userMessage" && item.type !== "agentMessage") {
    return { type: item.type, ...(item.truncated ? { truncated: true } : {}) };
  }
  const text = item.text && truncateUtf16Safe(item.text, 16_384);
  // A conversation-local exporter needs equality, never profile names or account identifiers.
  const speakerId = item.sender
    ? createHmac("sha256", salt)
        .update(sourceKey)
        .update("\0")
        .update(JSON.stringify(item.sender.identity, Object.keys(item.sender.identity).toSorted()))
        .digest("hex")
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
  let currentGrant: symbol;
  return {
    listCatalogs() {
      const grant = Symbol("catalog export grant");
      currentGrant = grant;
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
            grant !== currentGrant ||
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
        const speakerSalt = randomBytes(32);
        let latest = new Set<string>();
        const assertSource = (locator: Omit<SessionCatalogLocator, "catalogId">) => {
          assertCurrent(locator.agentId);
          if (!latest.has(key(locator.hostId, locator.threadId, locator.sourceHomeId))) {
            throw new Error("Select a listed local source");
          }
        };
        return [
          {
            id: provider.id,
            processHomeFallbackAllowed: allowProcessHomeFallback,
            assertCurrent: assertSource,
            async list(request) {
              assertCurrent(request.agentId);
              // Publishing a newer list retires grants and pending reads from the preceding one.
              const selected = new Set<string>();
              latest = selected;
              const source = request.source;
              if (source && request.cursors !== undefined) {
                throw new Error("Select an exact catalog source or request a page of hosts");
              }
              if (source && (!source.hostId || !source.threadId || source.threadId.length > 500)) {
                throw new Error("Invalid catalog source locator");
              }
              const hosts = new Set(
                (await localHosts({ agentId, allowProcessHomeFallback })).filter(
                  (id) => !source || id === source.hostId,
                ),
              );
              const assertListing = () => {
                assertCurrent(request.agentId);
                if (selected !== latest) {
                  throw new Error("Catalog listing superseded");
                }
              };
              assertListing();
              if (!hosts.size) {
                return [];
              }

              // Only the producer's currently admitted local hosts may receive a continuation.
              let cursors: Record<string, string> | undefined;
              if (request.cursors) {
                const allowed: Record<string, string> = Object.create(null);
                for (const hostId of hosts) {
                  const cursor = request.cursors[hostId];
                  if (Object.hasOwn(request.cursors, hostId) && typeof cursor === "string") {
                    allowed[hostId] = cursor;
                  }
                }
                cursors = allowed;
              }
              // Free-text search has no native-ID contract. The producer owns
              // visibility, the home boundary and its cheapest authoritative lookup.
              const listed = await provider.list({
                agentId,
                allowProcessHomeFallback,
                hostIds: [...hosts],
                ...(cursors ? { cursors } : {}),
                ...(source ? { exportSource: source } : {}),
                listNodes: async () => ({ nodes: [] }),
                limitPerHost: Math.min(Math.max(1, request.limitPerHost ?? 50), 100),
                signal: params.signal,
              });
              assertListing();
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
                    (source &&
                      (source.threadId !== row.threadId ||
                        source.sourceHomeId !== row.sourceHomeId)) ||
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
                      updatedAt: normalizeCatalogTimestamp(row.updatedAt),
                      recencyAt: normalizeCatalogTimestamp(row.recencyAt),
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
              assertSource(request);
              const granted = latest;
              if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 50) {
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
                items: page.items.map((item) =>
                  projectItem(
                    item,
                    speakerSalt,
                    key(request.hostId, request.threadId, request.sourceHomeId),
                  ),
                ),
              };
            },
          },
        ];
      });
    },
  };
}
