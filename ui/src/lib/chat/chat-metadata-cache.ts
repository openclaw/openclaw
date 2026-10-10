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
  type ModelCatalogInvalidation,
} from "../model-catalog-cache.ts";
import { readSessionChangedEvent } from "../sessions/reconcile.ts";
import type { UiSessionDefaultsHost } from "../sessions/session-key.ts";

export type ChatMetadataResult = CommandsListResult & { revision?: string };
export type ChatMetadataResponse =
  | (Partial<ChatMetadataResult> &
      Partial<Pick<ModelCatalogResult, "models" | "accountSelection" | "modelSelectionPolicy">>)
  | { revision: string; unchanged: true };

export type ChatMetadataUpdate =
  | { type: "invalidated"; scope: "session" | "full"; refreshSessionFacts: boolean }
  | { type: "loading" }
  | { type: "result"; result: ChatMetadataResult }
  | { type: "error"; error: unknown };
export type ChatMetadataPublication = {
  isCurrent: () => boolean;
  publish: (result: ChatMetadataResponse) => ChatMetadataResult;
  fail: (error: unknown) => void;
};
export type ChatMetadataRequest = {
  controller: AbortController;
  promise: Promise<ChatMetadataResult>;
  publication: ChatMetadataPublication;
  revalidation: boolean;
  start: () => void;
};
export type ChatMetadataRefresh = {
  catalog: Promise<ModelCatalogResult | undefined>;
  completed: Promise<void>;
  isCurrent: () => boolean;
};
export type ChatMetadataRefreshRecord = ChatMetadataRefresh & {
  controller: AbortController;
  phase: "waiting" | "admitted" | "inactive";
  revision: number;
  catalogRevision: number;
  metadataRequired: boolean;
  revalidateMetadata?: () => boolean;
  start: () => void;
};
export type ChatMetadataEntry = {
  scope: ChatMetadataParams;
  catalogController: AbortController;
  result?: ChatMetadataResult;
  invalidated?: boolean;
  activeRequest?: ChatMetadataRequest;
  queuedRequest?: ChatMetadataRequest;
  writer?: object;
  refreshRevision: number;
  refreshAfter?: number;
  catalogRevision: number;
  refresh?: ChatMetadataRefreshRecord;
  listeners: Map<(update: ChatMetadataUpdate) => void, () => boolean>;
  release: () => void;
};

export type ChatMetadataInvalidation = {
  sessionOnly?: boolean;
  matchesCatalog?: (scope: ChatMetadataParams) => boolean;
  commandsChanged?: boolean;
  delayMs?: number;
};

export const chatMetadataCache = new WeakMap<
  GatewayBrowserClient,
  {
    entries: Map<string, ChatMetadataEntry>;
    invalidate: (
      scope?: ChatMetadataParams,
      sessionDefaults?: UiSessionDefaultsHost,
      options?: ChatMetadataInvalidation,
    ) => void;
  }
>();

export function invalidateChatMetadataStore(
  client: GatewayBrowserClient,
  scope?: ChatMetadataParams,
  sessionDefaults?: UiSessionDefaultsHost,
  catalogInvalidation: ModelCatalogInvalidation | "preserve" = "refresh",
  commandsChanged = true,
): void {
  // Catalog readers share this lifecycle; retire their copies before metadata listeners reload.
  if (catalogInvalidation === "clear") {
    clearModelCatalogCache(client, { requireSnapshot: true });
  } else if (catalogInvalidation === "refresh") {
    invalidateModelCatalogCache(client, scope, sessionDefaults);
  }
  chatMetadataCache.get(client)?.invalidate(scope, sessionDefaults, { commandsChanged });
}

export function invalidateChatMetadataForSessionEvent(
  client: GatewayBrowserClient,
  payload: unknown,
  sessionDefaults: UiSessionDefaultsHost,
): void {
  const source = asNullableRecord(payload);
  const changed = readSessionChangedEvent(source);
  const session = asNullableRecord(source?.session);
  const agent = session?.agentId ?? source?.agentId;
  const agentId = typeof agent === "string" ? agent : undefined;
  const scope = changed ? { agentId, sessionKey: changed.key } : undefined;
  const sessionModelRevision =
    source?.catalogChanged !== true &&
    source?.phase !== "reset" &&
    source?.reason !== "reset" &&
    source?.reason !== "delete" &&
    source?.reason !== "cleanup" &&
    typeof session?.sessionModelRevision === "string"
      ? session.sessionModelRevision
      : undefined;
  const matchesCatalog = invalidateModelCatalogCache(
    client,
    {
      ...(scope ?? { agentId, sessionsOnly: true }),
      sessionModelRevision,
    },
    sessionDefaults,
  );
  // Native owners without a saved-row revision retain lazy activity invalidation.
  if (
    !sessionModelRevision &&
    source?.catalogChanged !== true &&
    ((!scope && source?.reason !== "delete" && source?.reason !== "cleanup") ||
      (source?.phase !== "reset" &&
        ![
          "reset",
          "patch",
          "command-metadata",
          "create",
          "new",
          "delete",
          "recovery",
          "cleanup",
        ].some((reason) => reason === source?.reason)))
  ) {
    return;
  }
  const delayMs =
    !sessionModelRevision &&
    source?.catalogChanged !== true &&
    source?.phase !== "reset" &&
    (source?.reason === "patch" || source?.reason === "command-metadata")
      ? 2_500
      : 0;
  chatMetadataCache.get(client)?.invalidate(scope, sessionDefaults, {
    sessionOnly: true,
    matchesCatalog,
    delayMs,
  });
}
