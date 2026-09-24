import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  ChatMetadataParams,
  CommandsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogResult } from "../../api/types.ts";
import {
  clearModelCatalogCache,
  invalidateModelCatalogCache,
  modelCatalogKey,
  modelCatalogParams,
} from "../model-catalog-cache.ts";
import { readSessionChangedEvent } from "../sessions/reconcile.ts";
import type { UiSessionDefaultsHost } from "../sessions/session-key.ts";

export type ChatMetadataResult = CommandsListResult;
export type ChatMetadataResponse = ChatMetadataResult &
  Partial<Pick<ModelCatalogResult, "models" | "accountSelection" | "modelSelectionPolicy">>;

export type ChatMetadataUpdate =
  | { type: "invalidated"; scope: "session" | "full"; refreshSessionFacts: boolean }
  | { type: "loading" }
  | { type: "result"; result: ChatMetadataResult; catalogChanged?: boolean }
  | { type: "error"; error: unknown };
export type ChatMetadataPublication = {
  isCurrent: () => boolean;
  publish: (result: ChatMetadataResponse) => ChatMetadataResult;
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
  refreshAfter?: number;
  validateCatalog?: boolean;
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
  retireCatalog = false,
): void {
  // Catalog readers share this lifecycle; retire their copies before metadata listeners reload.
  if (retireCatalog) {
    clearModelCatalogCache(client, { requireSnapshot: true });
  } else {
    invalidateModelCatalogCache(client, scope, sessionDefaults);
  }
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
  const retainedKeys =
    scope && isSessionMetadataInvalidation(source)
      ? new Set(
          Array.from(chatMetadataCache.get(client)?.entries.values() ?? [])
            .filter((entry) => entry.listeners.size > 0)
            .map((entry) => modelCatalogKey(modelCatalogParams(entry.scope))),
        )
      : undefined;
  // Only subscribed exact projections can wait for metadata validation. Other
  // aliases/views and coalesced activity reasons retain ordinary invalidation.
  invalidateModelCatalogCache(
    client,
    scope ?? { agentId, sessionsOnly: true },
    sessionDefaults,
    retainedKeys,
  );
  chatMetadataCache.get(client)?.invalidate(scope, sessionDefaults, source);
}

export function isSessionMetadataInvalidation(event?: Record<string, unknown> | null): boolean {
  return (
    event?.catalogChanged !== true &&
    event?.phase !== "reset" &&
    (event?.reason === "patch" || event?.reason === "command-metadata")
  );
}
