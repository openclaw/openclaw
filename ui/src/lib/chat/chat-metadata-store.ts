import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type { ChatMetadataParams } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { notifyListeners } from "../../../../src/shared/listeners.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogResult } from "../../api/types.ts";
import {
  invalidateModelCatalogCache,
  getModelCatalogCache,
  modelCatalogKey,
  modelCatalogParams,
} from "../model-catalog-cache.ts";
import {
  loadModelCatalog,
  peekModelCatalog,
  pendingModelCatalogResult,
  settleModelCatalogRequests,
  subscribeModelCatalogCache,
} from "../model-catalog-store.ts";
import { uiConversationMatches, type UiSessionDefaultsHost } from "../sessions/session-key.ts";
import {
  chatMetadataCache,
  isSessionMetadataInvalidation,
  type ChatMetadataEntry,
  type ChatMetadataPublication,
  type ChatMetadataRequest,
  type ChatMetadataRefresh,
  type ChatMetadataRefreshRecord,
  type ChatMetadataResult,
  type ChatMetadataResponse,
  type ChatMetadataUpdate,
} from "./chat-metadata-cache.ts";

function notifyChatMetadataListeners(entry: ChatMetadataEntry, update: ChatMetadataUpdate): void {
  notifyListeners(Array.from(entry.listeners.keys()), update, (error) =>
    console.error("[chat-metadata] listener error:", error),
  );
}

function metadataScopeKey({ agentId, sessionKey, authProfileId }: ChatMetadataParams): string {
  return JSON.stringify([agentId?.trim() ?? "", sessionKey ?? null, authProfileId ?? null]);
}

const MAX_CACHED_CHAT_METADATA = 64;
const SESSION_METADATA_DEBOUNCE_MS = 2_500;

function metadataEntryFor(
  client: GatewayBrowserClient,
  params: ChatMetadataParams,
): ChatMetadataEntry {
  const key = metadataScopeKey(params);
  let cache = chatMetadataCache.get(client);
  if (!cache) {
    const entries = new Map<string, ChatMetadataEntry>();
    const invalidate = (
      scope?: ChatMetadataParams,
      sessionDefaults?: UiSessionDefaultsHost,
      sessionEvent?: Record<string, unknown> | null,
    ) => {
      if (
        sessionEvent !== undefined &&
        sessionEvent?.catalogChanged !== true &&
        ((!scope && sessionEvent?.reason !== "delete" && sessionEvent?.reason !== "cleanup") ||
          (sessionEvent?.phase !== "reset" &&
            ![
              "reset",
              "patch",
              "command-metadata",
              "create",
              "new",
              "delete",
              "recovery",
              "cleanup",
            ].some((reason) => reason === sessionEvent?.reason)))
      ) {
        return;
      }
      const invalidated = Array.from(entries.values()).filter(
        (entry) =>
          (sessionEvent === undefined ||
            scope !== undefined ||
            entry.scope.sessionKey !== undefined) &&
          (sessionDefaults && scope?.sessionKey
            ? uiConversationMatches(
                sessionDefaults,
                entry.scope.sessionKey,
                scope.sessionKey,
                scope.agentId,
                entry.scope.agentId,
              )
            : (!scope?.agentId || entry.scope.agentId === scope.agentId) &&
              (!scope?.sessionKey || entry.scope.sessionKey === scope.sessionKey)) &&
          (!scope?.authProfileId || entry.scope.authProfileId === scope.authProfileId),
      );
      // Retire every affected writer before subscribers can synchronously start replacements.
      const sessionOnly =
        scope?.sessionKey !== undefined && isSessionMetadataInvalidation(sessionEvent);
      const catalog = sessionOnly ? getModelCatalogCache(client) : undefined;
      const validation =
        catalog &&
        new Set(
          Array.from(catalog.requests.values()).flatMap((lanes) =>
            Array.from(lanes.values()).flatMap(({ active }) => (active ? active.read : [])),
          ),
        );
      for (const entry of invalidated) {
        entry.refreshRevision += 1;
        entry.refreshAfter = sessionOnly ? Date.now() + SESSION_METADATA_DEBOUNCE_MS : undefined;
        entry.validateCatalog = entry.listeners.size > 0 ? validation : undefined;
        entry.result = undefined;
        entry.writer = undefined;
      }
      for (const entry of invalidated) {
        notifyChatMetadataListeners(entry, {
          type: "invalidated",
          scope: sessionOnly ? "session" : "full",
          refreshSessionFacts: sessionOnly || (sessionEvent === undefined && !scope?.sessionKey),
        });
        entry.release();
      }
    };
    cache = { entries, invalidate };
    chatMetadataCache.set(client, cache);
  }
  const entries = cache.entries;
  let entry = entries.get(key);
  if (!entry) {
    const catalogScope = modelCatalogParams(params);
    const catalogKey = modelCatalogKey(catalogScope);
    const created: ChatMetadataEntry = {
      scope: params,
      listeners: new Map(),
      refreshRevision: 0,
      catalogRevision: 0,
      release: () => {
        // Keep completed metadata across remounts; active consumers and transports are never evicted.
        if (
          created.listeners.size === 0 &&
          !created.activeRequest &&
          !created.queuedRequest &&
          (!created.result || entries.size > MAX_CACHED_CHAT_METADATA)
        ) {
          created.writer = undefined;
          if (entries.get(key) === created) {
            entries.delete(key);
            stopCatalog();
          }
        }
      },
    };
    const stopCatalog = subscribeModelCatalogCache(client, (update) => {
      if (update.type === "invalidated" && update.matches(catalogScope, catalogKey)) {
        created.catalogRevision += 1;
      }
    });
    entry = created;
    entries.set(key, entry);
    for (const candidate of entries.values()) {
      if (entries.size <= MAX_CACHED_CHAT_METADATA) {
        break;
      }
      if (candidate !== entry) {
        candidate.release();
      }
    }
  } else {
    entries.delete(key);
    entries.set(key, entry);
  }
  return entry;
}

function catalogProjectionKey(projection: Partial<ModelCatalogResult>) {
  // Metadata omits direct-picker policy, including on alternate runtime choices.
  return stableStringify([
    projection.models?.map(({ manualSelectionAllowed: _manual, runtimeChoices, ...model }) => ({
      ...model,
      runtimeChoices: runtimeChoices?.map(
        ({ manualSelectionAllowed: _choiceManual, ...choice }) => choice,
      ),
    })),
    projection.accountSelection,
    projection.modelSelectionPolicy,
  ]);
}

function preparePublication(
  client: GatewayBrowserClient,
  entry: ChatMetadataEntry,
): ChatMetadataPublication {
  const writer = {};
  entry.writer = writer;
  const isCurrent = () => entry.writer === writer;
  return {
    isCurrent,
    publish: (result) => {
      // Legacy/startup responses can carry models. The direct catalog is their only UI owner.
      const { models, accountSelection, modelSelectionPolicy, ...metadata } = result;
      if (isCurrent()) {
        let catalogChanged = false;
        const validateCatalog = entry.validateCatalog;
        if (validateCatalog) {
          entry.validateCatalog = undefined;
          const catalogRevision = entry.catalogRevision;
          const catalog = peekModelCatalog(client, entry.scope);
          const hasCatalogChanged = (validatedCatalog: ModelCatalogResult | undefined) =>
            !validatedCatalog ||
            catalogRevision !== entry.catalogRevision ||
            catalogProjectionKey({ models, accountSelection, modelSelectionPolicy }) !==
              catalogProjectionKey(validatedCatalog);
          const pending = !catalog
            ? pendingModelCatalogResult(client, entry.scope, validateCatalog)
            : undefined;
          if (pending) {
            // Commands are ready now; only catalog validation waits for its existing producer.
            void pending.then((validatedCatalog) => {
              if (isCurrent() && hasCatalogChanged(validatedCatalog)) {
                invalidateModelCatalogCache(client, entry.scope);
                notifyChatMetadataListeners(entry, {
                  type: "result",
                  result: metadata,
                  catalogChanged: true,
                });
              }
            });
          } else {
            catalogChanged = hasCatalogChanged(catalog);
          }
          if (catalogChanged) {
            invalidateModelCatalogCache(client, entry.scope);
          }
        }
        entry.result = metadata;
        notifyChatMetadataListeners(entry, {
          type: "result",
          result: metadata,
          ...(catalogChanged ? { catalogChanged: true } : {}),
        });
      }
      entry.release();
      return metadata;
    },
    fail: (error: unknown) => {
      if (isCurrent()) {
        notifyChatMetadataListeners(entry, { type: "error", error });
      }
      entry.release();
    },
  };
}

function beginChatMetadataRequest(
  client: GatewayBrowserClient,
  entry: ChatMetadataEntry,
  revalidation: boolean,
): Promise<ChatMetadataResult> {
  const publication = preparePublication(client, entry);
  const queued = entry.queuedRequest;
  if (queued) {
    // Pending demand adopts the latest writer, but never adds another queued read.
    queued.publication = publication;
    queued.revalidation ||= revalidation;
    notifyChatMetadataListeners(entry, { type: "loading" });
    return queued.promise;
  }
  const { promise, resolve, reject } = createDeferredCore<ChatMetadataResult>();
  const request: ChatMetadataRequest = {
    promise,
    publication,
    revalidation,
    start: () => {
      // Once dispatched, this request cannot regain publication authority after invalidation.
      const activePublication = request.publication;
      void (async () => {
        try {
          let result: ChatMetadataResponse;
          try {
            result = await client.request<ChatMetadataResponse>("chat.metadata", entry.scope);
          } finally {
            // Observers may retry synchronously; retire the settled request before notifying them.
            entry.activeRequest = undefined;
            const next = entry.queuedRequest;
            entry.queuedRequest = undefined;
            if (next) {
              entry.activeRequest = next;
              next.start();
            }
          }
          resolve(activePublication.publish(result));
        } catch (error) {
          activePublication.fail(error);
          reject(error);
        } finally {
          entry.release();
        }
      })();
    },
  };
  if (entry.activeRequest) {
    entry.queuedRequest = request;
  } else {
    entry.activeRequest = request;
  }
  // Reserve ownership before consumers synchronously react to the new generation.
  notifyChatMetadataListeners(entry, { type: "loading" });
  if (entry.activeRequest === request) {
    request.start();
  }
  return promise;
}

export function peekChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
): ChatMetadataResult | undefined {
  return chatMetadataCache.get(client)?.entries.get(metadataScopeKey(scope))?.result;
}

export function subscribeChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
  listener: (update: ChatMetadataUpdate) => void,
  isActive: () => boolean = () => true,
): () => void {
  const entry = metadataEntryFor(client, scope);
  entry.listeners.set(listener, isActive);
  return () => {
    entry.listeners.delete(listener);
    if ((scope.sessionKey || scope.authProfileId) && entry.listeners.size === 0) {
      entry.refreshRevision += 1;
      entry.writer = undefined;
      if (entry.validateCatalog) {
        entry.validateCatalog = undefined;
        invalidateModelCatalogCache(client, scope);
      }
    }
    entry.refresh?.start();
    entry.release();
  };
}

export function loadChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
): Promise<ChatMetadataResult> {
  const entry = metadataEntryFor(client, scope);
  if (entry.result) {
    return Promise.resolve(entry.result);
  }
  const request = entry.queuedRequest ?? entry.activeRequest;
  if (request?.publication.isCurrent()) {
    return request.promise;
  }
  return beginChatMetadataRequest(client, entry, false);
}

export function revalidateChatMetadata(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
): Promise<ChatMetadataResult> {
  const entry = metadataEntryFor(client, scope);
  const request = entry.queuedRequest ?? entry.activeRequest;
  if (
    request?.publication.isCurrent() &&
    (request.revalidation || request === entry.queuedRequest)
  ) {
    request.revalidation = true;
    return request.promise;
  }
  return beginChatMetadataRequest(client, entry, true);
}

export function beginChatMetadataPublication(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
) {
  const entry = metadataEntryFor(client, scope);
  const { isCurrent, publish } = preparePublication(client, entry);
  notifyChatMetadataListeners(entry, { type: "loading" });
  return { isCurrent, publish };
}

export function retireChatMetadataRefresh(client: GatewayBrowserClient, scope: ChatMetadataParams) {
  const entry = metadataEntryFor(client, scope);
  entry.refreshRevision += 1;
  entry.refreshAfter = undefined;
  const previous = entry.refresh;
  entry.refresh = undefined;
  previous?.start();
}

/** Automatic presentations share admission; command and catalog owners dispatch their own reads. */
export function loadChatMetadataRefresh(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
  options?: { kind?: "startup" | "metadata"; revalidateMetadata?: () => boolean },
): ChatMetadataRefresh {
  const entry = metadataEntryFor(client, scope);
  // Expiry belongs to the catalog owner and may retire the previous attempt synchronously.
  peekModelCatalog(client, scope);
  const previous = entry.refresh;
  const startupOwnsMetadata =
    options?.kind === undefined &&
    previous?.revision === entry.refreshRevision &&
    !previous.metadataRequired;
  const metadataRequired = options?.kind !== "startup" && !startupOwnsMetadata;
  if (previous?.phase === "waiting") {
    previous.metadataRequired ||= metadataRequired;
    previous.revalidateMetadata = options?.revalidateMetadata ?? previous.revalidateMetadata;
    previous.revision = entry.refreshRevision;
    previous.catalogRevision = entry.catalogRevision;
    previous.start();
    return previous;
  }
  if (
    previous &&
    previous.phase !== "inactive" &&
    previous.revision === entry.refreshRevision &&
    previous.catalogRevision === entry.catalogRevision &&
    !options?.revalidateMetadata &&
    (!metadataRequired || previous.metadataRequired || options?.kind === undefined)
  ) {
    return previous;
  }
  const requestedRevision = entry.refreshRevision;
  const requestedCatalogRevision = entry.catalogRevision;
  const startupCatalog =
    previous?.revision === requestedRevision &&
    previous.catalogRevision === requestedCatalogRevision &&
    previous.phase !== "inactive" &&
    options?.kind === "metadata"
      ? previous.catalog
      : undefined;
  const catalog = createDeferredCore<ModelCatalogResult | undefined>();
  const completed = createDeferredCore();
  let wakePending = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const record: ChatMetadataRefreshRecord = {
    catalog: catalog.promise,
    completed: completed.promise,
    revision: requestedRevision,
    catalogRevision: requestedCatalogRevision,
    phase: "waiting",
    metadataRequired,
    revalidateMetadata: options?.revalidateMetadata,
    isCurrent: () =>
      chatMetadataCache.get(client)?.entries.get(metadataScopeKey(scope)) === entry &&
      record.revision === entry.refreshRevision &&
      record.catalogRevision === entry.catalogRevision,
    start: () => {
      if (record.phase !== "waiting") {
        return;
      }
      clearTimeout(debounceTimer);
      peekModelCatalog(client, scope);
      const current = entry.refresh === record;
      const active = current && Array.from(entry.listeners.values()).some((isActive) => isActive());
      const delay = (entry.refreshAfter ?? 0) - Date.now();
      if (active && delay > 0) {
        debounceTimer = setTimeout(record.start, delay);
        return;
      }
      if (active && record.metadataRequired && entry.queuedRequest) {
        // Refresh the queued publication without admitting another transport.
        void loadChatMetadata(client, scope);
      }
      const inheritedCatalog =
        requestedRevision === entry.refreshRevision &&
        requestedCatalogRevision === entry.catalogRevision
          ? startupCatalog
          : undefined;
      // A same-generation startup extension adds commands beside its existing catalog.
      // Hidden or invalidated demand must retain both producer barriers through remount.
      const catalogSettlement =
        inheritedCatalog && active ? undefined : settleModelCatalogRequests(client, scope);
      const pending = [entry.activeRequest?.promise, catalogSettlement].filter(
        (promise) => promise !== undefined,
      );
      if (current && pending.length) {
        if (!wakePending) {
          wakePending = true;
          void Promise.allSettled(pending).then(() => {
            wakePending = false;
            record.start();
          });
        }
        return;
      }
      if (!active) {
        record.phase = "inactive";
        catalog.resolve(undefined);
        completed.resolve();
        entry.release();
        return;
      }
      record.phase = "admitted";
      record.revision = entry.refreshRevision;
      record.catalogRevision = entry.catalogRevision;
      const catalogRead = inheritedCatalog ?? loadModelCatalog(client, scope);
      const metadataRead = record.metadataRequired
        ? record.revalidateMetadata?.()
          ? revalidateChatMetadata(client, scope)
          : loadChatMetadata(client, scope)
        : Promise.resolve();
      void catalogRead.then(catalog.resolve, catalog.reject);
      void Promise.allSettled([metadataRead, catalog.promise]).then(() => {
        completed.resolve();
        entry.release();
      });
    },
  };
  entry.refresh = record;
  record.start();
  return record;
}
