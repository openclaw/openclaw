import { html } from "lit";
import type { SettingsAppHost, SettingsHost } from "../../app/app-host.ts";
import { t } from "../../i18n/index.ts";
import { formatTimeMs } from "../../lib/format.ts";
import { isPluginEnabledInConfigSnapshot } from "../../lib/plugin-activation.ts";
import { definePage } from "../../router/index.ts";
import { switchChatSession } from "../../ui/app-render.helpers.ts";
import type { AppViewState } from "../../ui/app-view-state.ts";
import {
  resolveChatAgentFilterId,
  resolveChatAgentFilterOptions,
  resolvePreferredSessionForAgent,
} from "../../ui/chat/session-controls.ts";
import { loadConfig, openConfigFile } from "../config/data.ts";
import { loadDreamsPage } from "../loaders.ts";
import {
  backfillDreamDiary,
  copyDreamingArchivePath,
  dedupeDreamDiary,
  loadDreamDiary,
  loadDreamingStatus,
  loadWikiImportInsights,
  loadWikiMemoryPalace,
  repairDreamingArtifacts,
  resetGroundedShortTerm,
  resetDreamDiary,
  resolveConfiguredDreaming,
  updateDreamingEnabled,
} from "./data.ts";
import { renderDreamingRestartConfirmation } from "./restart-confirmation.ts";
import { renderDreaming } from "./view.ts";

type DreamsLoadContext = { host: SettingsHost; app: SettingsAppHost };
type DreamsRenderContext = { state: AppViewState };

export function formatDreamNextCycle(nextRunAtMs: number | undefined): string | null {
  return formatTimeMs(nextRunAtMs, { hour: "numeric", minute: "2-digit" }, "") || null;
}

function resolveDreamingNextCycle(
  status: { phases?: Record<string, { enabled: boolean; nextRunAtMs?: number }> } | null,
): string | null {
  const nextRunAtMs = Object.values(status?.phases ?? {})
    .filter((phase) => phase.enabled && typeof phase.nextRunAtMs === "number")
    .map((phase) => phase.nextRunAtMs as number)
    .sort((a, b) => a - b)[0];
  return nextRunAtMs === undefined ? null : formatDreamNextCycle(nextRunAtMs);
}

function openWikiPage(state: AppViewState, lookup: string) {
  return (
    state.client
      ?.request("wiki.get", {
        lookup,
        fromLine: 1,
        lineCount: 5000,
      })
      .then((payload) => {
        const value = payload as {
          title?: unknown;
          path?: unknown;
          content?: unknown;
          updatedAt?: unknown;
          totalLines?: unknown;
          truncated?: unknown;
        } | null;
        const title =
          typeof value?.title === "string" && value.title.trim() ? value.title.trim() : lookup;
        const path =
          typeof value?.path === "string" && value.path.trim() ? value.path.trim() : lookup;
        const content =
          typeof value?.content === "string" && value.content.length > 0
            ? value.content
            : "No wiki content available.";
        const updatedAt =
          typeof value?.updatedAt === "string" && value.updatedAt.trim()
            ? value.updatedAt.trim()
            : undefined;
        const totalLines =
          typeof value?.totalLines === "number" && Number.isFinite(value.totalLines)
            ? Math.max(0, Math.floor(value.totalLines))
            : undefined;
        return {
          title,
          path,
          content,
          ...(totalLines === undefined ? {} : { totalLines }),
          ...(value?.truncated === true ? { truncated: true } : {}),
          ...(updatedAt ? { updatedAt } : {}),
        };
      }) ?? Promise.resolve(null)
  );
}

function renderDreamsPage(state: AppViewState) {
  const requestUpdate = (state as AppViewState & { requestUpdate?: () => void }).requestUpdate;
  const configValue =
    state.configForm ?? (state.configSnapshot?.config as Record<string, unknown> | null);
  const dreamingOn =
    state.dreamingStatus?.enabled ?? resolveConfiguredDreaming(configValue).enabled;
  const selectedAgentId = resolveChatAgentFilterId(state, state.sessionKey);
  const agentOptions = resolveChatAgentFilterOptions(state);
  const loading = state.dreamingStatusLoading || state.dreamingModeSaving;
  const refreshLoading = state.dreamingStatusLoading || state.dreamDiaryLoading;
  const syncSelectedAgent = () => {
    const agentId = resolveChatAgentFilterId(state, state.sessionKey);
    state.selectedAgentId = agentId;
    return agentId;
  };
  const refresh = () => {
    void (async () => {
      syncSelectedAgent();
      await loadConfig(state);
      await Promise.all([
        loadDreamingStatus(state),
        loadDreamDiary(state),
        loadWikiImportInsights(state),
        loadWikiMemoryPalace(state),
      ]);
    })();
  };
  const setEnabled = (enabled: boolean) => {
    if (
      state.dreamingModeSaving ||
      state.dreamingRestartConfirmLoading ||
      state.dreamingRestartConfirmOpen ||
      dreamingOn === enabled
    ) {
      return;
    }
    state.dreamingPendingEnabled = enabled;
    state.dreamingRestartConfirmOpen = true;
    state.dreamingStatusError = null;
  };
  const cancelRestart = () => {
    if (state.dreamingRestartConfirmLoading) {
      return;
    }
    state.dreamingRestartConfirmOpen = false;
    state.dreamingPendingEnabled = null;
    state.dreamingStatusError = null;
  };
  const confirmRestart = () => {
    const enabled = state.dreamingPendingEnabled;
    if (enabled == null || state.dreamingRestartConfirmLoading) {
      return;
    }
    void (async () => {
      state.dreamingRestartConfirmLoading = true;
      state.dreamingStatusError = null;
      try {
        const updated = await updateDreamingEnabled(state, enabled);
        if (!updated) {
          state.dreamingStatusError ??= t("dreaming.restartConfirmation.failed");
          return;
        }
        await loadConfig(state);
        await loadDreamingStatus(state);
        state.dreamingRestartConfirmOpen = false;
        state.dreamingPendingEnabled = null;
      } finally {
        state.dreamingRestartConfirmLoading = false;
      }
    })();
  };

  return html`
    <section class="content-header">
      <div>
        <div class="page-title">${t("tabs.dreams")}</div>
        <div class="page-sub">${t("subtitles.dreams")}</div>
      </div>
      <div class="page-meta">
        <div class="dreaming-header-controls">
          <button
            class="btn btn--subtle btn--sm"
            ?disabled=${loading || state.dreamDiaryLoading}
            @click=${refresh}
          >
            ${refreshLoading ? t("dreaming.header.refreshing") : t("dreaming.header.refresh")}
          </button>
          <button
            class="dreams__phase-toggle ${dreamingOn ? "dreams__phase-toggle--on" : ""}"
            ?disabled=${loading}
            @click=${() => setEnabled(!dreamingOn)}
          >
            <span class="dreams__phase-toggle-dot"></span>
            <span class="dreams__phase-toggle-label">
              ${dreamingOn ? t("dreaming.header.on") : t("dreaming.header.off")}
            </span>
          </button>
        </div>
      </div>
    </section>
    ${renderDreaming({
      active: dreamingOn,
      selectedAgentId,
      agentOptions,
      shortTermCount: state.dreamingStatus?.shortTermCount ?? 0,
      groundedSignalCount: state.dreamingStatus?.groundedSignalCount ?? 0,
      totalSignalCount: state.dreamingStatus?.totalSignalCount ?? 0,
      promotedCount: state.dreamingStatus?.promotedToday ?? 0,
      phases: state.dreamingStatus?.phases ?? undefined,
      shortTermEntries: state.dreamingStatus?.shortTermEntries ?? [],
      promotedEntries: state.dreamingStatus?.promotedEntries ?? [],
      dreamingOf: null,
      nextCycle: resolveDreamingNextCycle(state.dreamingStatus),
      timezone: state.dreamingStatus?.timezone ?? null,
      statusLoading: state.dreamingStatusLoading,
      statusError: state.dreamingStatusError,
      modeSaving: state.dreamingModeSaving,
      dreamDiaryLoading: state.dreamDiaryLoading,
      dreamDiaryActionLoading: state.dreamDiaryActionLoading,
      dreamDiaryActionMessage: state.dreamDiaryActionMessage,
      dreamDiaryActionArchivePath: state.dreamDiaryActionArchivePath,
      dreamDiaryError: state.dreamDiaryError,
      dreamDiaryPath: state.dreamDiaryPath,
      dreamDiaryContent: state.dreamDiaryContent,
      memoryWikiEnabled: isPluginEnabledInConfigSnapshot(state.configSnapshot, "memory-wiki", {
        enabledByDefault: false,
      }),
      wikiImportInsightsLoading: state.wikiImportInsightsLoading,
      wikiImportInsightsError: state.wikiImportInsightsError,
      wikiImportInsights: state.wikiImportInsights,
      wikiMemoryPalaceLoading: state.wikiMemoryPalaceLoading,
      wikiMemoryPalaceError: state.wikiMemoryPalaceError,
      wikiMemoryPalace: state.wikiMemoryPalace,
      onRefresh: refresh,
      onSelectAgent: (agentId: string) => {
        state.selectedAgentId = agentId;
        switchChatSession(state, resolvePreferredSessionForAgent(state, agentId));
        void loadDreamingStatus(state);
        void loadDreamDiary(state);
      },
      onRefreshDiary: () => {
        syncSelectedAgent();
        void loadDreamDiary(state);
      },
      onRefreshImports: () => void loadConfig(state).then(() => loadWikiImportInsights(state)),
      onRefreshMemoryPalace: () => void loadConfig(state).then(() => loadWikiMemoryPalace(state)),
      onOpenConfig: () => void openConfigFile(state),
      onOpenWikiPage: (lookup: string) => openWikiPage(state, lookup),
      onBackfillDiary: () => {
        syncSelectedAgent();
        void backfillDreamDiary(state);
      },
      onCopyDreamingArchivePath: () => void copyDreamingArchivePath(state),
      onDedupeDreamDiary: () => {
        syncSelectedAgent();
        void dedupeDreamDiary(state);
      },
      onResetDiary: () => {
        syncSelectedAgent();
        void resetDreamDiary(state);
      },
      onResetGroundedShortTerm: () => {
        syncSelectedAgent();
        void resetGroundedShortTerm(state);
      },
      onRepairDreamingArtifacts: () => {
        syncSelectedAgent();
        void repairDreamingArtifacts(state);
      },
      onRequestUpdate: requestUpdate,
    })}
    ${renderDreamingRestartConfirmation({
      open: state.dreamingRestartConfirmOpen,
      loading: state.dreamingRestartConfirmLoading,
      onConfirm: confirmRestart,
      onCancel: cancelRestart,
      hasError: Boolean(state.dreamingStatusError),
    })}
  `;
}

export const page = definePage({
  id: "dreams",
  path: "/dreaming",
  aliases: ["/dreams"],
  loader: ({ host, app }: DreamsLoadContext) => loadDreamsPage(host, app),
  component: () => ({
    header: true,
    render: ({ state }: DreamsRenderContext) => renderDreamsPage(state),
  }),
});
