import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, ModelCatalogResult } from "../../api/types.ts";
import type {
  ChatMetadataResult,
  ChatMetadataRefresh,
} from "../../lib/chat/chat-metadata-cache.ts";
import {
  loadChatMetadata,
  peekChatMetadata,
  beginChatMetadataPublication,
  subscribeChatMetadata,
  loadChatMetadataRefresh,
  retireChatMetadataRefresh,
} from "../../lib/chat/chat-metadata-store.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { loadModelAuthStatus } from "../../lib/model-auth.ts";
import { loadModelCatalog, peekModelCatalog } from "../../lib/model-catalog-store.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { reconcileSessionHistory } from "../../lib/sessions/reconcile.ts";
import {
  isUiSelectedGlobalSessionKey,
  parseAgentSessionKey,
} from "../../lib/sessions/session-key.ts";
import { isPersistedSessionRow } from "../../lib/sessions/session-row-reconcile.ts";
import { refreshChatAvatar, resolveAgentIdForSession } from "./chat-avatar.ts";
import { applyRemoteSlashCommandsResult, refreshSlashCommands } from "./chat-commands.ts";
import type { ObservedChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { flushChatQueueAfterIdleSessionReconciliation } from "./chat-queue-reconnect.ts";
import { flushChatQueueForEvent } from "./chat-send-actions.ts";
import {
  refreshCurrentChatSessionList,
  retireChatModelSelectionOwnership,
} from "./chat-session.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { resolveChatAgentId, selectedChatSessionRow } from "./chat-state-route.ts";
import {
  reconcileChatRunFromCurrentSessionRow,
  reconcileChatRunFromSessionRow,
} from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";

type ChatRefreshOptions = {
  deferBranches?: boolean;
  historyLoad?: Promise<ObservedChatHistoryResult | undefined>;
  scheduleScroll?: boolean;
  awaitHistory?: boolean;
  startup?: boolean;
};

type ChatStartupMetadataHandler = (
  metadata: ChatMetadataResult | undefined,
) => void | Promise<void>;

type ChatMetadataBinding = {
  client: GatewayBrowserClient;
  sessions: ChatPageHost["sessions"];
  scope: { agentId?: string; sessionKey: string };
  version: number;
  sessionFactsInvalidated: boolean;
  sessionRefreshPending?: boolean;
  sessionFactsRetryPending?: boolean;
  sessionFactsRequest?: { version: number; promise: Promise<void> };
  refreshPending?: { refresh: ChatMetadataRefresh; promise: Promise<void> };
  catalogRequest?: { version: number; controller: AbortController; promise: Promise<boolean> };
  isCurrent: () => boolean;
  unsubscribe: () => void;
};
const metadataBindings = new WeakMap<ChatPageHost, ChatMetadataBinding>();

export function retireChatMetadataRequests(host: ChatPageHost): void {
  metadataBindings.get(host)?.catalogRequest?.controller.abort();
  metadataBindings.get(host)?.unsubscribe();
  metadataBindings.delete(host);
  host.chatModelCatalog = [];
  host.chatModelCatalogError = null;
  host.chatModelCatalogRefreshFailed = undefined;
  host.chatModelCatalogPendingProviders = undefined;
  host.chatModelsLoading = false;
  host.chatAccountSelection = null;
}

function scheduleChatMetadataRefresh(callback: () => void) {
  const requestIdleCallback =
    typeof globalThis.requestIdleCallback === "function" ? globalThis.requestIdleCallback : null;
  if (requestIdleCallback) {
    requestIdleCallback(callback, { timeout: 750 });
    return;
  }
  globalThis.setTimeout(callback, 50);
}

export async function refreshChatCommands(host: ChatPageHost) {
  await refreshSlashCommands({
    client: host.client,
    agentId: resolveChatAgentId(host),
    sessionKey: host.sessionKey,
  });
}

export function applySelectedChatAgent(
  host: ChatPageHost | null | undefined,
  selectedAgentId: string | null,
): void {
  if (
    !host ||
    !isUiSelectedGlobalSessionKey(host, host.sessionKey) ||
    parseAgentSessionKey(host.sessionKey)?.agentId ||
    (host.assistantAgentId ?? null) === selectedAgentId
  ) {
    return;
  }
  applyChatAgentOwnerTransition(host, selectedAgentId);
  void refreshCurrentChatSessionList(host);
}

export function applyChatAgentOwnerTransition(
  host: ChatPageHost,
  selectedAgentId: string | null,
): void {
  if ((host.assistantAgentId ?? null) === selectedAgentId) {
    return;
  }
  retireChatModelSelectionOwnership(host);
  host.assistantIdentityRequestVersion += 1;
  host.assistantAgentId = selectedAgentId;
  host.assistantName = "";
  host.assistantAvatar = null;
  host.assistantAvatarSource = null;
  host.assistantAvatarStatus = null;
  host.assistantAvatarReason = null;
  host.chatAvatarUrl = null;
  host.chatAvatarSource = null;
  host.chatAvatarStatus = null;
  host.chatAvatarReason = null;
  host.modelAuthStatusResult = null;
  host.modelAuthStatusError = null;
  // Global chats retain their session key across agent selection. Replace agent-owned
  // bindings now so their old fences reject later publications.
  void refreshChatMetadata(host, { automatic: true });
  void refreshChatModelAuthStatus(host).finally(() => host.requestUpdate?.());
  void host.loadAssistantIdentity();
  host.requestUpdate?.();
}

function bindChatMetadata(host: ChatPageHost): ChatMetadataBinding | undefined {
  const previous = metadataBindings.get(host);
  if (previous?.isCurrent()) {
    return previous;
  }
  if (previous) {
    retireChatMetadataRequests(host);
  }
  const client = host.client;
  if (!client || !host.connected) {
    return undefined;
  }
  const scope = { agentId: resolveChatAgentId(host) ?? undefined, sessionKey: host.sessionKey };
  const epoch = host.connectionEpoch;
  const binding: ChatMetadataBinding = {
    client,
    sessions: host.sessions,
    scope,
    version: 0,
    sessionFactsInvalidated: false,
    isCurrent: () =>
      metadataBindings.get(host) === binding &&
      host.connected &&
      host.client === client &&
      host.sessions === binding.sessions &&
      host.connectionEpoch === epoch &&
      host.sessionKey === scope.sessionKey &&
      (resolveChatAgentId(host) ?? undefined) === scope.agentId,
    unsubscribe: subscribeChatMetadata(
      client,
      scope,
      (update) => {
        if (!binding.isCurrent()) {
          return;
        }
        if (update.type === "invalidated" || update.type === "loading") {
          binding.sessionRefreshPending =
            update.type === "invalidated" && update.scope === "session";
          binding.version += 1;
          if (binding.sessionFactsRequest) {
            binding.sessionFactsInvalidated = true;
            binding.sessionFactsRetryPending = true;
          }
        }
        if (update.type === "invalidated") {
          if (update.scope === "full") {
            binding.catalogRequest?.controller.abort();
            binding.catalogRequest = undefined;
            host.chatModelsLoading = false;
          }
          binding.sessionFactsInvalidated ||= update.refreshSessionFacts;
          void refreshChatMetadata(host, { automatic: true });
          return;
        }
        if (update.type !== "loading") {
          if (update.type === "result") {
            applyRemoteSlashCommandsResult({
              client,
              agentId: scope.agentId,
              result: update.result,
            });
            if (update.catalogChanged) {
              binding.sessionFactsInvalidated = true;
              void refreshChatMetadata(host, { automatic: true });
            }
          }
          if (binding.sessionFactsRetryPending) {
            binding.sessionFactsRetryPending = false;
            applyChatModelCatalogSnapshot(host);
          }
        }
        host.requestUpdate?.();
      },
      () => binding.isCurrent() && host.chatMetadataIsPresented?.() !== false,
    ),
  };
  metadataBindings.set(host, binding);
  const cached = peekChatMetadata(client, scope);
  if (cached) {
    applyRemoteSlashCommandsResult({ client, agentId: scope.agentId, result: cached });
  }
  return binding;
}

export async function refreshChatMetadata(
  host: ChatPageHost,
  options?: { automatic?: boolean; startup?: boolean },
): Promise<void> {
  const binding = bindChatMetadata(host);
  if (!binding) {
    retireChatMetadataRequests(host);
    return;
  }
  if (options?.automatic) {
    if (host.chatMetadataIsPresented?.() === false) {
      return;
    }
    const refresh = loadChatMetadataRefresh(binding.client, binding.scope, {
      kind: options.startup ? "startup" : undefined,
    });
    const freshCatalog = applyChatModelCatalogSnapshot(host);
    if (binding.refreshPending?.refresh === refresh) {
      return binding.refreshPending.promise;
    }
    // Presentation changes owners; the model cache still owns the direct transport.
    binding.catalogRequest = undefined;
    host.chatModelsLoading = !freshCatalog && host.chatModelCatalog.length === 0;
    host.requestUpdate?.();
    const ownsRefresh = () =>
      binding.isCurrent() && refresh.isCurrent() && binding.refreshPending?.refresh === refresh;
    let retryRetiredCatalog = false;
    const catalog = refresh.catalog
      .then(
        async (result) => {
          // Applying a current cooldown response may expire it; that must not create a retry loop.
          retryRetiredCatalog = !refresh.isCurrent();
          if (!result || !binding.isCurrent() || binding.refreshPending?.refresh !== refresh) {
            return;
          }
          // Another pane can discover expiry after this snapshot was canonically accepted.
          if (
            retryRetiredCatalog &&
            peekModelCatalog(binding.client, binding.scope, { allowStale: true }) !== result
          ) {
            return;
          }
          retryRetiredCatalog = false;
          // The receipt signals completion; the model owner supplies current or stale display data.
          applyCachedChatModelCatalog(host, binding);
          if (!ownsRefresh()) {
            return;
          }
          host.chatModelsLoading = false;
          host.requestUpdate?.();
          if (binding.sessionFactsInvalidated && host.chatMetadataIsPresented?.() !== false) {
            await refreshChatSessionFacts(host, binding);
          }
        },
        (error: unknown) => {
          retryRetiredCatalog = !refresh.isCurrent();
          if (ownsRefresh() && !applyChatModelCatalogSnapshot(host) && ownsRefresh()) {
            host.chatModelCatalogError = formatUiError(error);
            host.chatModelsLoading = false;
            host.requestUpdate?.();
          }
        },
      )
      .finally(() => {
        if (binding.isCurrent() && binding.refreshPending?.refresh === refresh) {
          host.chatModelsLoading = false;
          host.requestUpdate?.();
        }
      });
    const promise = Promise.allSettled([refresh.completed, catalog]).then(() => {
      if (binding.refreshPending?.refresh === refresh) {
        binding.refreshPending = undefined;
        if (retryRetiredCatalog && binding.isCurrent()) {
          return refreshChatMetadata(host, { automatic: true });
        }
      }
      return undefined;
    });
    binding.refreshPending = { refresh, promise };
    return promise;
  }
  binding.refreshPending = undefined;
  retireChatMetadataRefresh(binding.client, binding.scope);
  // Only accepted store publications update availability or fetch errors.
  const metadata = loadChatMetadata(binding.client, binding.scope).catch(() => undefined);
  const version = binding.version;
  const catalog = loadChatModelCatalog(host, binding).then(async (accepted) => {
    if (
      binding.sessionFactsInvalidated &&
      accepted &&
      binding.isCurrent() &&
      binding.version === version
    ) {
      await refreshChatSessionFacts(host, binding);
    }
  });
  await Promise.all([metadata, catalog]);
}

function refreshChatSessionFacts(host: ChatPageHost, binding: ChatMetadataBinding): Promise<void> {
  binding.sessionFactsRetryPending = false;
  const version = binding.version;
  if (binding.sessionFactsRequest?.version === version) {
    return binding.sessionFactsRequest.promise;
  }
  const agentId = binding.scope.agentId;
  if (!agentId || !binding.isCurrent()) {
    return Promise.resolve();
  }
  // A catalog changes descriptor facts, not roster membership. The row owner
  // projects the accepted read into held windows without issuing new list queries.
  const observation = binding.sessions.observeRow(
    { key: binding.scope.sessionKey, agentId },
    () => {},
  );
  const reconcile = observation.captureReconcile();
  binding.sessionFactsInvalidated = false;
  const promise = binding.client
    .request<{ session?: GatewaySessionRow | null }>("sessions.describe", {
      key: binding.scope.sessionKey,
      agentId,
    })
    .then((result) => {
      if (!binding.isCurrent() || binding.version !== version) {
        return;
      }
      const outcome = reconcile(result.session ?? undefined);
      if (!binding.isCurrent() || binding.version !== version) {
        return;
      }
      if (outcome.status === "invalidated") {
        binding.sessionFactsInvalidated = true;
        binding.sessionFactsRequest = undefined;
      }
      if (outcome.status === "current" && host.sessionsResult) {
        host.sessionsResult = {
          ...host.sessionsResult,
          sessions: binding.sessions.projectRows(host.sessionsResult.sessions),
        };
        host.requestUpdate?.();
      }
    })
    .catch(() => {
      if (binding.isCurrent() && binding.version === version) {
        binding.sessionFactsInvalidated = true;
        binding.sessionFactsRequest = undefined;
      }
    })
    .finally(() => {
      observation.dispose();
      if (binding.sessionFactsRequest?.promise === promise) {
        binding.sessionFactsRequest = undefined;
      }
    });
  binding.sessionFactsRequest = { version, promise };
  return promise;
}

export async function refreshChatModelAuthStatus(host: ChatPageHost, opts?: { refresh?: boolean }) {
  if (!host.client || !host.connected) {
    return;
  }
  const client = host.client;
  const connectionEpoch = host.connectionEpoch;
  const agentId = resolveChatAgentId(host);
  const requestVersion = ++host.modelAuthStatusRequestVersion;
  const ownsRequest = () =>
    host.client === client &&
    host.connected &&
    host.connectionEpoch === connectionEpoch &&
    host.modelAuthStatusRequestVersion === requestVersion &&
    resolveChatAgentId(host) === agentId;
  try {
    const result = await loadModelAuthStatus(client, {
      ...opts,
      agentId,
    });
    if (!ownsRequest()) {
      return;
    }
    host.modelAuthStatusResult = result;
    host.modelAuthStatusError = result.unavailable?.message ?? null;
  } catch (err) {
    if (!ownsRequest()) {
      return;
    }
    host.modelAuthStatusResult = { ts: 0, providers: [] };
    host.modelAuthStatusError = formatUiError(err);
  }
}

async function loadChatModelCatalog(
  host: ChatPageHost,
  binding: ChatMetadataBinding,
): Promise<boolean> {
  if (applyCachedChatModelCatalog(host, binding)) {
    return true;
  }
  if (binding.catalogRequest?.version === binding.version) {
    return binding.catalogRequest.promise;
  }
  binding.catalogRequest?.controller.abort();
  const controller = new AbortController();
  const version = binding.version;
  const ownsRequest = () =>
    binding.isCurrent() && binding.catalogRequest?.controller === controller;
  host.chatModelsLoading = host.chatModelCatalog.length === 0;
  host.requestUpdate?.();
  const promise = loadModelCatalog(binding.client, { ...binding.scope, signal: controller.signal })
    .then(
      (result) => {
        if (!binding.isCurrent()) {
          return false;
        }
        const fresh = peekModelCatalog(binding.client, binding.scope);
        if (fresh || ownsRequest()) {
          applyCachedChatModelCatalog(host, binding);
          const accepted =
            Boolean(fresh) ||
            peekModelCatalog(binding.client, binding.scope, { allowStale: true }) === result;
          if (!accepted && ownsRequest()) {
            binding.catalogRequest = undefined;
            return loadChatModelCatalog(host, binding);
          }
          return accepted;
        }
        return false;
      },
      (error: unknown) => {
        if (ownsRequest()) {
          host.chatModelCatalogError = formatUiError(error);
        }
        return false;
      },
    )
    .finally(() => {
      if (ownsRequest()) {
        binding.catalogRequest = undefined;
        host.chatModelsLoading = false;
        host.requestUpdate?.();
      }
    });
  binding.catalogRequest = { version, controller, promise };
  return promise;
}

function applyChatModelCatalog(host: ChatPageHost, result: ModelCatalogResult) {
  host.chatModelCatalog = result.models;
  host.chatAccountSelection = result.accountSelection ?? null;
  host.chatModelCatalogError = null;
  host.chatModelCatalogRefreshFailed = result.refreshFailed;
  host.chatModelCatalogPendingProviders = result.pendingProviders;
}

function applyCachedChatModelCatalog(host: ChatPageHost, binding: ChatMetadataBinding): boolean {
  const fresh = peekModelCatalog(binding.client, binding.scope);
  const result = fresh ?? peekModelCatalog(binding.client, binding.scope, { allowStale: true });
  if (!result || !binding.isCurrent()) {
    return false;
  }
  if (fresh) {
    binding.catalogRequest?.controller.abort();
    binding.catalogRequest = undefined;
  }
  applyChatModelCatalog(host, result);
  host.chatModelsLoading = false;
  host.requestUpdate?.();
  return Boolean(fresh);
}

export function applyChatModelCatalogSnapshot(host: ChatPageHost): boolean {
  const binding = metadataBindings.get(host);
  const fresh = Boolean(binding && applyCachedChatModelCatalog(host, binding));
  if (
    binding &&
    fresh &&
    !binding.sessionRefreshPending &&
    binding.sessionFactsInvalidated &&
    host.chatMetadataIsPresented?.() !== false
  ) {
    void refreshChatSessionFacts(host, binding);
  }
  return fresh;
}

export async function refreshChatModelCatalogOnDemand(host: ChatPageHost): Promise<void> {
  const binding = bindChatMetadata(host);
  if (binding && applyCachedChatModelCatalog(host, binding)) {
    return;
  }
  if (binding) {
    binding.refreshPending = undefined;
    retireChatMetadataRefresh(binding.client, binding.scope);
  }
  if (binding && (await loadChatModelCatalog(host, binding)) && binding.isCurrent()) {
    // Session-owned thinking/context facts must converge with the published model catalog.
    await refreshChatSessionFacts(host, binding);
  }
}

async function refreshChat(
  host: ChatPageHost,
  opts?: ChatRefreshOptions & {
    onStartupMetadata?: ChatStartupMetadataHandler;
  },
) {
  const refreshedClient = host.client;
  const refreshedSessions = host.sessions;
  const refreshedEpoch = host.connectionEpoch;
  const refreshedSessionKey = host.sessionKey;
  const refreshedAgentId = resolveAgentIdForSession(host);
  const ownsRefresh = () =>
    host.connected &&
    host.sessions === refreshedSessions &&
    host.client === refreshedClient &&
    host.connectionEpoch === refreshedEpoch &&
    host.sessionKey === refreshedSessionKey &&
    resolveAgentIdForSession(host) === refreshedAgentId;
  const requestUpdate = () => host.requestUpdate?.();
  const previousSessionsResult = host.sessionsResult;
  const historyLoad =
    opts?.historyLoad ??
    loadChatHistory(host, {
      deferBranches: opts?.deferBranches === true,
      startup: opts?.startup === true,
    });
  const historyRefresh = historyLoad.finally(() => {
    if (opts?.scheduleScroll !== false) {
      scheduleChatScroll(host);
    }
    requestUpdate();
  });
  const sessionsRefresh = historyLoad.then((history) => {
    if (
      !history?.sessionInfo ||
      !ownsRefresh() ||
      history.observation.owner !== refreshedSessions
    ) {
      return;
    }
    const admitted = history.observation.reconcile(history.sessionInfo, history.defaults, {
      resultAgentId: host.sessions.state.agentId ?? refreshedAgentId,
      selectedGlobalAgentId: refreshedAgentId,
      // The routed chat remains visible after archive even though the active
      // roster excludes it. Keep its descriptor in shared session state until
      // navigation changes; otherwise the pane briefly falls back to the raw
      // key while the sidebar lineage reload catches up.
      archivedFilter: history.sessionInfo.archived === true ? "all" : host.sessionsArchivedFilter,
    });
    if (!admitted || !ownsRefresh()) {
      return;
    }
    // The shared roster may belong to another agent. Keep this pane's accepted
    // history separate rather than relabeling or borrowing that roster.
    const scopedHistory =
      host.sessions.state.agentId !== refreshedAgentId &&
      (isUiSelectedGlobalSessionKey(host, refreshedSessionKey) ||
        isPersistedSessionRow(history.sessionInfo));
    host.sessionsResult = scopedHistory
      ? reconcileSessionHistory(
          host.sessionsResultAgentId === refreshedAgentId ? host.sessionsResult : null,
          admitted === "defaults-only" ? selectedChatSessionRow(host) : history.sessionInfo,
          history.defaults,
          {
            resultAgentId: refreshedAgentId,
            selectedGlobalAgentId: refreshedAgentId,
            archivedFilter: "all",
          },
          // Defaults-only admission preserves the current descriptor even when history
          // began before this refresh captured the pane's projection.
          admitted === "defaults-only" ||
            (host.sessionsResultAgentId === refreshedAgentId &&
              host.sessionsResult !== previousSessionsResult),
        )
      : host.sessions.state.result;
    host.sessionsResultAgentId = scopedHistory ? refreshedAgentId : host.sessions.state.agentId;
    // Defaults-only admission cannot update descriptor flags or run state from stale history.
    if (admitted === "defaults-only") {
      return;
    }
    const sessionInfo = selectedChatSessionRow(host);
    const rosterRow = sessionInfo ?? history.sessionInfo;
    if (sessionInfo) {
      host.selectedChatSessionArchived = rosterRow.archived === true;
      host.selectedChatSessionIncognito = rosterRow.incognito === true;
    }
    const snapshotRunId = history.inFlightRun?.runId?.trim();
    const activeRunIds = history.sessionInfo.activeRunIds;
    const snapshotConfirmsCurrentRun = Boolean(
      snapshotRunId &&
      host.chatRunId === snapshotRunId &&
      isSessionRunActive(history.sessionInfo) &&
      (!Array.isArray(activeRunIds) || activeRunIds.includes(snapshotRunId)),
    );
    if (snapshotConfirmsCurrentRun) {
      // History just adopted this authoritative active run. A newer catalog
      // timestamp may still describe its prior terminal state during remount.
      return;
    }
    if (!sessionInfo) {
      return;
    }
    const runReconciled = reconcileChatRunFromSessionRow(host, sessionInfo, {
      publishRunStatus: true,
      historyRun:
        history.observation.run &&
        history.sessionInfo.hasActiveRun === false &&
        !isSessionRunActive(history.sessionInfo) &&
        !history.inFlightRun &&
        history.sessionInfo.sessionId === history.observation.run.sessionId
          ? history.observation.run
          : null,
    });
    if (!runReconciled && !host.chatRunId && host.chatStream == null) {
      reconcileChatRunFromCurrentSessionRow(host, { publishRunStatus: true });
    }
  });
  const startupMetadataRefresh =
    opts?.startup === true && opts.onStartupMetadata
      ? historyLoad.then(
          (history) => opts.onStartupMetadata?.(history?.metadata),
          () => opts.onStartupMetadata?.(undefined),
        )
      : Promise.resolve();
  flushChatQueueAfterIdleSessionReconciliation(
    host,
    refreshedSessionKey,
    historyRefresh,
    sessionsRefresh,
    previousSessionsResult,
    () => void flushChatQueueForEvent(host),
  );
  const secondaryRefresh = Promise.allSettled([sessionsRefresh, startupMetadataRefresh]).finally(
    requestUpdate,
  );
  void historyRefresh;
  void secondaryRefresh;
  if (opts?.awaitHistory === true) {
    await historyRefresh;
    return;
  }
  await Promise.resolve();
}

export function refreshPageChat(host: ChatPageHost, opts?: ChatRefreshOptions) {
  const binding = opts?.startup ? bindChatMetadata(host) : undefined;
  const publication = binding
    ? beginChatMetadataPublication(binding.client, binding.scope)
    : undefined;
  if (binding) {
    void refreshChatMetadata(host, { automatic: true, startup: true });
  }
  const refresh = refreshChat(host, {
    ...opts,
    onStartupMetadata: async (metadata) => {
      // The publication belongs to the shared scope, not the pane that started history.
      // Final subscriber release or invalidation retires it; one pane closing must not.
      if (!binding || !publication?.isCurrent()) {
        return;
      }
      if (metadata) {
        publication.publish(metadata);
      } else {
        // Startup can omit its bounded projection. Read the same session scope without history.
        const fallback = loadChatMetadataRefresh(binding.client, binding.scope, {
          kind: "metadata",
          revalidateMetadata: () => publication.isCurrent(),
        });
        await fallback.completed;
      }
    },
  });
  const sessionKey = host.sessionKey;
  const client = host.client;
  const epoch = host.connectionEpoch;
  scheduleChatMetadataRefresh(() => {
    if (
      !host.connected ||
      host.client !== client ||
      host.connectionEpoch !== epoch ||
      host.sessionKey !== sessionKey
    ) {
      return;
    }
    void Promise.allSettled([
      refreshChatAvatar(host),
      ...(!opts?.startup ? [refreshChatMetadata(host, { automatic: true })] : []),
    ]).finally(() => host.requestUpdate?.());
  });
  return refresh;
}
