import {
  DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
  resolveGatewayStartupRetryAfterMs,
} from "@openclaw/gateway-client/browser";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import type { ChatMetadataParams } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogResult } from "../../api/types.ts";
import {
  invalidateModelCatalogCache,
  modelCatalogKey,
  modelCatalogParams,
} from "../model-catalog-cache.ts";
import {
  loadModelCatalog,
  peekModelCatalog,
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
  for (const listener of Array.from(entry.listeners.keys())) {
    try {
      listener(update);
    } catch (error) {
      console.error("[chat-metadata] listener error:", error);
    }
  }
}

function metadataScopeKey(scope: ChatMetadataParams): string {
  return JSON.stringify([
    scope.agentId?.trim() ?? "",
    scope.sessionKey ?? null,
    scope.authProfileId ?? null,
  ]);
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
      for (const entry of invalidated) {
        entry.refreshRevision += 1;
        entry.refreshAfter = sessionOnly ? Date.now() + SESSION_METADATA_DEBOUNCE_MS : undefined;
        entry.validateCatalog = sessionOnly && entry.listeners.size > 0;
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
    cache = {
      entries,
      invalidate,
    };
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

function waitForMetadataRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

async function requestChatMetadata(
  client: GatewayBrowserClient,
  params: ChatMetadataParams,
  deadlineAt?: number,
): Promise<ChatMetadataResponse> {
  if (deadlineAt === undefined) {
    return client.request<ChatMetadataResponse>("chat.metadata", params);
  }

  let latestStartupError: Error | undefined;

  while (true) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw latestStartupError ?? new Error("New-session metadata retry deadline elapsed");
    }

    try {
      return await client.request<ChatMetadataResponse>("chat.metadata", params, {
        timeoutMs: Math.min(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, remainingMs),
      });
    } catch (error) {
      const requestError =
        error instanceof Error
          ? error
          : new Error("New-session metadata request failed", { cause: error });
      const retryAfterMs = resolveGatewayStartupRetryAfterMs(requestError);
      if (retryAfterMs === null) {
        throw requestError;
      }

      const retryRemainingMs = deadlineAt - Date.now();
      if (retryRemainingMs <= 0) {
        throw requestError;
      }

      latestStartupError = requestError;
      await waitForMetadataRetry(Math.min(retryAfterMs, retryRemainingMs));
    }
  }
}

function catalogProjectionKey(
  models: ModelCatalogResult["models"],
  accountSelection: ModelCatalogResult["accountSelection"],
  modelSelectionPolicy: ModelCatalogResult["modelSelectionPolicy"],
) {
  // Metadata omits direct-picker policy, including on alternate runtime choices.
  return stableStringify([
    models.map(({ manualSelectionAllowed: _manual, runtimeChoices, ...model }) => ({
      ...model,
      ...(runtimeChoices
        ? {
            runtimeChoices: runtimeChoices.map(
              ({ manualSelectionAllowed: _choiceManual, ...choice }) => choice,
            ),
          }
        : {}),
    })),
    accountSelection,
    modelSelectionPolicy,
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
        if (entry.validateCatalog) {
          entry.validateCatalog = false;
          const catalog = peekModelCatalog(client, entry.scope);
          // A patch can also change a session's account/runtime projection. Metadata
          // is only an invalidation signal; the direct catalog remains the display owner.
          if (
            !catalog ||
            models === undefined ||
            catalogProjectionKey(models, accountSelection, modelSelectionPolicy) !==
              catalogProjectionKey(
                catalog.models,
                catalog.accountSelection,
                catalog.modelSelectionPolicy,
              )
          ) {
            invalidateModelCatalogCache(client, entry.scope);
            catalogChanged = true;
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
  startupRetryDeadlineAt?: number,
): Promise<ChatMetadataResult> {
  const publication = preparePublication(client, entry);
  const queued = entry.queuedRequest;
  if (queued) {
    // Pending demand adopts the latest writer, but never adds another queued read.
    queued.publication = publication;
    queued.revalidation ||= revalidation;
    queued.setStartupRetryDeadline(startupRetryDeadlineAt);
    notifyChatMetadataListeners(entry, { type: "loading" });
    return queued.promise;
  }
  const { promise, resolve, reject } = createDeferredCore<ChatMetadataResult>();
  let started = false;
  let retryDeadlineAt = startupRetryDeadlineAt;
  let queueDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const request: ChatMetadataRequest = {
    promise,
    publication,
    revalidation,
    setStartupRetryDeadline: (deadlineAt) => {
      if (started || deadlineAt === undefined) {
        return;
      }
      retryDeadlineAt = Math.min(retryDeadlineAt ?? deadlineAt, deadlineAt);
      if (entry.queuedRequest !== request) {
        return;
      }
      clearTimeout(queueDeadlineTimer);
      queueDeadlineTimer = setTimeout(
        () => {
          if (entry.queuedRequest !== request) {
            return;
          }
          entry.queuedRequest = undefined;
          const error = new Error("New-session metadata retry deadline elapsed");
          request.publication.fail(error);
          reject(error);
          entry.release();
        },
        Math.max(0, retryDeadlineAt - Date.now()),
      );
    },
    start: () => {
      started = true;
      clearTimeout(queueDeadlineTimer);
      // Once dispatched, this request cannot regain publication authority after invalidation.
      const activePublication = request.publication;
      void (async () => {
        try {
          const result = await requestChatMetadata(client, entry.scope, retryDeadlineAt).finally(
            () => {
              // Observers may retry synchronously; retire the settled request before notifying them.
              entry.activeRequest = undefined;
              const next = entry.queuedRequest;
              entry.queuedRequest = undefined;
              if (next) {
                entry.activeRequest = next;
                next.start();
              }
            },
          );
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
  request.setStartupRetryDeadline(startupRetryDeadlineAt);
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
        entry.validateCatalog = false;
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
  opts?: { startupRetryWindowMs?: number },
): Promise<ChatMetadataResult> {
  const entry = metadataEntryFor(client, scope);
  const request = entry.queuedRequest ?? entry.activeRequest;
  const deadlineAt =
    opts?.startupRetryWindowMs === undefined ? undefined : Date.now() + opts.startupRetryWindowMs;
  if (
    request?.publication.isCurrent() &&
    (request.revalidation || request === entry.queuedRequest)
  ) {
    request.revalidation = true;
    request.setStartupRetryDeadline(deadlineAt);
    return request.promise;
  }
  return beginChatMetadataRequest(client, entry, true, deadlineAt);
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
