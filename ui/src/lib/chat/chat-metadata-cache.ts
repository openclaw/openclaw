import type {
  ChatMetadataParams,
  CommandsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { invalidateModelCatalogCache } from "../model-catalog-cache.ts";

export type ChatMetadataResult = CommandsListResult;

export type ChatMetadataUpdate =
  | { type: "invalidated" }
  | { type: "loading" }
  | { type: "result"; result: ChatMetadataResult }
  | { type: "error"; error: unknown };
export type ChatMetadataEntry = {
  scope: ChatMetadataParams;
  result?: ChatMetadataResult;
  loadPending?: Promise<ChatMetadataResult>;
  revalidationPending?: Promise<ChatMetadataResult>;
  writer?: object;
  listeners: Set<(update: ChatMetadataUpdate) => void>;
  release: () => void;
};

export const chatMetadataCache = new WeakMap<
  GatewayBrowserClient,
  Map<string, ChatMetadataEntry>
>();

export function notifyChatMetadataListeners(
  entry: ChatMetadataEntry,
  update: ChatMetadataUpdate,
): void {
  for (const listener of Array.from(entry.listeners)) {
    try {
      listener(update);
    } catch (error) {
      console.error("[chat-metadata] listener error:", error);
    }
  }
}

export function invalidateChatMetadataStore(
  client: GatewayBrowserClient,
  scope?: ChatMetadataParams,
): void {
  // Catalog readers share this lifecycle; retire their copies before metadata listeners reload.
  invalidateModelCatalogCache(client, scope);
  const entries = chatMetadataCache.get(client)?.values();
  if (!entries) {
    return;
  }
  const invalidated = Array.from(entries).filter(
    (entry) =>
      (!scope?.agentId || entry.scope.agentId === scope.agentId) &&
      (!scope?.sessionKey || entry.scope.sessionKey === scope.sessionKey) &&
      (!scope?.authProfileId || entry.scope.authProfileId === scope.authProfileId),
  );
  // Retire every affected writer before subscribers can synchronously start replacements.
  for (const entry of invalidated) {
    entry.result = undefined;
    entry.loadPending = undefined;
    entry.revalidationPending = undefined;
    entry.writer = undefined;
  }
  for (const entry of invalidated) {
    notifyChatMetadataListeners(entry, { type: "invalidated" });
    entry.release();
  }
}
