import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ChatMetadataParams,
  CommandsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogResult } from "../../api/types.ts";
import { invalidateModelCatalogCache } from "../model-catalog-cache.ts";
import { readSessionChangedEvent } from "../sessions/reconcile.ts";
import type { UiSessionDefaultsHost } from "../sessions/session-key.ts";

export type ChatMetadataResult = CommandsListResult;

export type ChatMetadataUpdate =
  | { type: "invalidated"; refreshSessionFacts: boolean }
  | { type: "loading" }
  | { type: "result"; result: ChatMetadataResult }
  | { type: "error"; error: unknown };
export type ChatMetadataPublication = {
  isCurrent: () => boolean;
  publish: (
    result: ChatMetadataResult & { models?: unknown; accountSelection?: unknown },
  ) => ChatMetadataResult;
  fail: (error: unknown) => void;
};
export type ChatMetadataRequest = {
  promise: Promise<ChatMetadataResult>;
  publication: ChatMetadataPublication;
  revalidation: boolean;
  setStartupRetryDeadline: (deadlineAt?: number) => void;
  start: () => void;
};
export type ChatMetadataRefresh = {
  catalog: Promise<ModelCatalogResult | undefined>;
  completed: Promise<void>;
  isCurrent: () => boolean;
};
export type ChatMetadataRefreshRecord = ChatMetadataRefresh & {
  phase: "waiting" | "admitted" | "inactive";
  revision: number;
  catalogRevision: number;
  metadataRequired: boolean;
  revalidateMetadata?: () => boolean;
  start: () => void;
};
export type ChatMetadataEntry = {
  scope: ChatMetadataParams;
  result?: ChatMetadataResult;
  activeRequest?: ChatMetadataRequest;
  queuedRequest?: ChatMetadataRequest;
  writer?: object;
  refreshRevision: number;
  catalogRevision: number;
  refresh?: ChatMetadataRefreshRecord;
  listeners: Map<(update: ChatMetadataUpdate) => void, () => boolean>;
  release: () => void;
};

export const chatMetadataCache = new WeakMap<
  GatewayBrowserClient,
  {
    entries: Map<string, ChatMetadataEntry>;
    invalidate: (
      scope?: ChatMetadataParams,
      sessionDefaults?: UiSessionDefaultsHost,
      sessionEvent?: Record<string, unknown> | null,
    ) => void;
  }
>();

export function invalidateChatMetadataStore(
  client: GatewayBrowserClient,
  scope?: ChatMetadataParams,
  sessionDefaults?: UiSessionDefaultsHost,
): void {
  // Catalog readers share this lifecycle; retire their copies before metadata listeners reload.
  invalidateModelCatalogCache(client, scope, sessionDefaults);
  chatMetadataCache.get(client)?.invalidate(scope, sessionDefaults);
}

export function invalidateChatMetadataForSessionEvent(
  client: GatewayBrowserClient,
  payload: unknown,
  sessionDefaults: UiSessionDefaultsHost,
): void {
  const source = asNullableRecord(payload);
  const changed = readSessionChangedEvent(source);
  const agentId = typeof source?.agentId === "string" ? source.agentId : undefined;
  const scope = changed ? { agentId, sessionKey: changed.key } : undefined;
  // Coalesced events can replace a mutation's reason with later activity.
  invalidateModelCatalogCache(client, scope ?? { agentId, sessionsOnly: true }, sessionDefaults);
  chatMetadataCache.get(client)?.invalidate(scope, sessionDefaults, source);
}
