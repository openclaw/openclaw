import { sleepWithAbort } from "@openclaw/retry";
import type { ChatMetadataParams } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import { notifyListeners } from "../../../../src/shared/listeners.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogResult } from "../../api/types.ts";
import {
  isAgentDatabaseInspectionPendingError,
  resolveGatewayReadRetryDelayMs,
} from "../gateway-availability.ts";
import { modelCatalogKey, modelCatalogParams } from "../model-catalog-cache.ts";
import {
  loadModelCatalog,
  peekModelCatalog,
  settleModelCatalogRequests,
  subscribeModelCatalogCache,
} from "../model-catalog-store.ts";
import { uiConversationMatches, type UiSessionDefaultsHost } from "../sessions/session-key.ts";
import {
  chatMetadataCache,
  type ChatMetadataEntry,
  type ChatMetadataInvalidation,
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
      {
        sessionOnly = false,
        matchesCatalog,
        commandsChanged = true,
        delayMs = 0,
      }: ChatMetadataInvalidation = {},
    ) => {
      const invalidated = Array.from(entries.values()).filter(
        (entry) =>
          (!matchesCatalog || matchesCatalog(entry.scope)) &&
          (!sessionOnly || scope !== undefined || entry.scope.sessionKey !== undefined) &&
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
      for (const entry of invalidated) {
        entry.refreshRevision += 1;
        entry.refreshAfter = delayMs ? Date.now() + delayMs : undefined;
        if (!sessionOnly && commandsChanged) {
          entry.invalidated = true;
          entry.writer = undefined;
          entry.activeRequest?.controller.abort();
        }
      }
      for (const entry of invalidated) {
        notifyChatMetadataListeners(entry, {
          type: "invalidated",
          scope: sessionOnly ? "session" : "full",
          refreshSessionFacts: sessionOnly || !scope?.sessionKey,
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
      catalogController: new AbortController(),
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

function preparePublication(entry: ChatMetadataEntry): ChatMetadataPublication {
  const writer = {};
  entry.writer = writer;
  const isCurrent = () => entry.writer === writer;
  return {
    isCurrent,
    publish: (result) => {
      // Startup responses may include a catalog; models.list owns its UI publication.
      const metadata =
        "unchanged" in result
          ? entry.result
          : result.commands === undefined
            ? undefined
            : {
                commands: result.commands,
                ...(result.revision ? { revision: result.revision } : {}),
              };
      if (!metadata) {
        if (isCurrent()) {
          entry.invalidated = true;
        }
        throw new Error("Chat commands are unavailable. Retry the metadata request.");
      }
      if ("unchanged" in result && metadata.revision !== result.revision) {
        throw new Error("Chat metadata was unchanged without a retained revision.");
      }
      if (isCurrent()) {
        entry.result = metadata;
        entry.invalidated = false;
        notifyChatMetadataListeners(entry, {
          type: "result",
          result: metadata,
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
  const publication = preparePublication(entry);
  const queued = entry.queuedRequest;
  if (queued) {
    // Pending demand adopts the latest writer, but never adds another queued read.
    if (queued.controller.signal.aborted) {
      queued.controller = new AbortController();
    }
    queued.publication = publication;
    queued.revalidation ||= revalidation;
    notifyChatMetadataListeners(entry, { type: "loading" });
    return queued.promise;
  }
  const { promise, resolve, reject } = createDeferredCore<ChatMetadataResult>();
  const waitsForActiveRequest = entry.activeRequest !== undefined;
  const request: ChatMetadataRequest = {
    controller: new AbortController(),
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
            if (waitsForActiveRequest) {
              request.controller.signal.throwIfAborted();
            }
            let startupAttempt = 0;
            while (true) {
              if (startupAttempt > 0) {
                request.controller.signal.throwIfAborted();
              }
              try {
                result = await client.request<ChatMetadataResponse>("chat.metadata", {
                  agentId: entry.scope.agentId,
                  includeModels: false,
                  ...(entry.result?.revision ? { ifRevision: entry.result.revision } : {}),
                });
                break;
              } catch (error) {
                if (!isAgentDatabaseInspectionPendingError(error)) {
                  throw error;
                }
                await sleepWithAbort(
                  resolveGatewayReadRetryDelayMs(error, startupAttempt++),
                  request.controller.signal,
                );
              }
            }
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
  const entry = chatMetadataCache.get(client)?.entries.get(metadataScopeKey(scope));
  return entry?.invalidated ? undefined : entry?.result;
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
    if (entry.listeners.size === 0) {
      entry.activeRequest?.controller.abort();
      entry.queuedRequest?.controller.abort();
      entry.catalogController.abort();
    }
    if ((scope.sessionKey || scope.authProfileId) && entry.listeners.size === 0) {
      entry.refreshRevision += 1;
      entry.writer = undefined;
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
  if (entry.result && !entry.invalidated) {
    return Promise.resolve(entry.result);
  }
  const request = entry.queuedRequest ?? entry.activeRequest;
  if (request?.publication.isCurrent() && !request.controller.signal.aborted) {
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
    !request.controller.signal.aborted &&
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
  const { isCurrent, publish } = preparePublication(entry);
  notifyChatMetadataListeners(entry, { type: "loading" });
  return { isCurrent, publish };
}

export function retireChatMetadataRefresh(client: GatewayBrowserClient, scope: ChatMetadataParams) {
  const entry = metadataEntryFor(client, scope);
  entry.refreshRevision += 1;
  entry.refreshAfter = undefined;
  const previous = entry.refresh;
  entry.refresh = undefined;
  // Foreground demand can adopt this catalog read; only scope release cancels it.
  previous?.start();
}

/** Automatic presentations share admission; command and catalog owners dispatch their own reads. */
export function loadChatMetadataRefresh(
  client: GatewayBrowserClient,
  scope: ChatMetadataParams,
  options?: { kind?: "startup" | "metadata"; revalidateMetadata?: () => boolean },
): ChatMetadataRefresh {
  const entry = metadataEntryFor(client, scope);
  if (entry.catalogController.signal.aborted) {
    entry.catalogController = new AbortController();
  }
  // Expiry belongs to the catalog owner and may retire the previous attempt synchronously.
  peekModelCatalog(client, scope);
  const previous = entry.refresh;
  const startupOwnsMetadata =
    options?.kind === undefined &&
    previous?.revision === entry.refreshRevision &&
    !previous.controller.signal.aborted &&
    !previous.metadataRequired;
  const metadataRequired = options?.kind !== "startup" && !startupOwnsMetadata;
  if (previous?.phase === "waiting" && !previous.controller.signal.aborted) {
    previous.metadataRequired ||= metadataRequired;
    previous.revalidateMetadata = options?.revalidateMetadata ?? previous.revalidateMetadata;
    previous.revision = entry.refreshRevision;
    previous.catalogRevision = entry.catalogRevision;
    previous.start();
    return previous;
  }
  if (
    previous &&
    !previous.controller.signal.aborted &&
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
    !previous.controller.signal.aborted &&
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
    controller: entry.catalogController,
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
      const active =
        current &&
        !record.controller.signal.aborted &&
        Array.from(entry.listeners.values()).some((isActive) => isActive());
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
      const catalogRead =
        inheritedCatalog ??
        loadModelCatalog(client, { ...scope, signal: record.controller.signal });
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
