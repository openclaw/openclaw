import { t } from "../../i18n/index.ts";
import type { ChatMetadataResult } from "../../lib/chat/chat-metadata-cache.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { reconcileSessionHistory } from "../../lib/sessions/reconcile.ts";
import { isUiSelectedGlobalSessionKey } from "../../lib/sessions/session-key.ts";
import { isPersistedSessionRow } from "../../lib/sessions/session-row-reconcile.ts";
import { showToast } from "../../lib/toast.ts";
import { resolveAgentIdForSession } from "./chat-avatar.ts";
import type { ObservedChatHistoryResult } from "./chat-history-snapshot.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { flushChatQueueAfterIdleSessionReconciliation } from "./chat-queue-reconnect.ts";
import { flushChatQueueForEvent } from "./chat-send-actions.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { recordControlUiPerformanceEvent } from "./performance.ts";
import {
  reconcileChatRunFromSessionRow,
  reconcileChatRunFromCurrentSessionRow,
} from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";

export type ChatRefreshOptions = {
  deferBranches?: boolean;
  historyLoad?: Promise<ObservedChatHistoryResult | undefined>;
  scheduleScroll?: boolean;
  awaitHistory?: boolean;
  startup?: boolean;
  explicit?: boolean;
};

type ChatStartupMetadataHandler = (
  metadata: ChatMetadataResult | undefined,
) => void | Promise<void>;

export async function refreshChat(
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
  // Manual status reads do not submit work; normal reconciliation owns queued sends.
  if (!opts?.explicit) {
    flushChatQueueAfterIdleSessionReconciliation(
      host,
      refreshedSessionKey,
      historyRefresh,
      sessionsRefresh,
      previousSessionsResult,
      () => void flushChatQueueForEvent(host),
    );
  }
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

export function createChatRefreshFeedback(host: ChatPageHost, opts: ChatRefreshOptions) {
  const sessionKey = host.sessionKey;
  const client = host.client;
  const epoch = host.connectionEpoch;
  const sessions = host.sessions;
  const agentId = resolveAgentIdForSession(host);
  const row = selectedChatSessionRow(host);
  const scope = {
    sessionKey,
    sessionId: host.currentSessionId ?? row?.sessionId ?? null,
    connectionEpoch: epoch,
    placementGeneration: row?.placement?.generation ?? null,
    runId: host.chatRunId ?? host.chatRunError?.runId ?? null,
  };
  const ownsFeedback = () =>
    host.connected &&
    host.client === client &&
    host.sessions === sessions &&
    host.connectionEpoch === epoch &&
    host.sessionKey === sessionKey &&
    resolveAgentIdForSession(host) === agentId &&
    (!scope.sessionId ||
      (host.currentSessionId ?? selectedChatSessionRow(host)?.sessionId) === scope.sessionId);
  const report = (
    stage: "invoked" | "request" | "result",
    outcome?: "refreshed" | "failed" | "superseded",
  ) => {
    if (opts?.explicit) {
      recordControlUiPerformanceEvent(
        host,
        "chat.refresh",
        {
          ...scope,
          stage,
          ...(outcome ? { outcome } : {}),
          method: opts.startup ? "chat.startup" : "chat.history",
        },
        { maxBufferedEventsForType: 8 },
      );
    }
  };
  report("invoked");
  return {
    requested() {
      report("request");
      host.requestUpdate?.();
    },
    complete(refresh: Promise<void>) {
      if (!opts.explicit) {
        return refresh;
      }
      const failed = () => {
        const current = ownsFeedback();
        report("result", current ? "failed" : "superseded");
        if (current) {
          showToast({ message: t("chat.refreshFailed") });
        }
      };
      return refresh
        .then(async () => {
          const observed = await opts.historyLoad;
          const current = ownsFeedback();
          const load = getChatHistoryLoadState(host);
          if (!current || (!observed && load.phase !== "failed")) {
            report("result", "superseded");
            return;
          }
          if (load.phase === "failed") {
            failed();
            return;
          }
          report("result", "refreshed");
          showToast({
            message: t(
              selectedChatSessionRow(host)?.placement?.state === "failed"
                ? "chat.refreshWorkerFailed"
                : "chat.refreshCompleted",
            ),
          });
        })
        .catch(failed);
    },
  };
}
