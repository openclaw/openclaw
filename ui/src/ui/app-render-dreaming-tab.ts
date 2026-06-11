import { html } from "lit";
import { t } from "../i18n/index.ts";
import type { AppViewState } from "./app-view-state.ts";
import { loadConfig, openConfigFile } from "./controllers/config.ts";
import {
  backfillDreamDiary,
  copyDreamingArchivePath,
  dedupeDreamDiary,
  loadDreamDiary,
  loadDreamingStatus,
  loadWikiImportInsights,
  loadWikiMemoryPalace,
  repairDreamingArtifacts,
  resetDreamDiary,
  resetGroundedShortTerm,
  updateDreamingEnabled,
} from "./controllers/dreaming.ts";
import { isPluginEnabledInConfigSnapshot } from "./plugin-activation.ts";
import { renderDreaming } from "./views/dreaming.ts";

function formatDreamNextCycle(nextRunAtMs: number | undefined): string | null {
  if (typeof nextRunAtMs !== "number" || !Number.isFinite(nextRunAtMs)) {
    return null;
  }
  return new Date(nextRunAtMs).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function resolveDreamingNextCycle(
  status: { phases?: Record<string, { enabled: boolean; nextRunAtMs?: number }> } | null,
): string | null {
  if (!status?.phases) {
    return null;
  }
  let nextRunAtMs: number | undefined;
  for (const phase of Object.values(status.phases)) {
    if (!phase.enabled || typeof phase.nextRunAtMs !== "number") {
      continue;
    }
    if (nextRunAtMs === undefined || phase.nextRunAtMs < nextRunAtMs) {
      nextRunAtMs = phase.nextRunAtMs;
    }
  }
  return formatDreamNextCycle(nextRunAtMs);
}

export function refreshDreaming(state: AppViewState) {
  void (async () => {
    await loadConfig(state);
    await Promise.all([
      loadDreamingStatus(state),
      loadDreamDiary(state),
      loadWikiImportInsights(state),
      loadWikiMemoryPalace(state),
    ]);
  })();
}

async function openWikiPage(state: AppViewState, lookup: string) {
  if (!state.client || !state.connected) {
    return null;
  }
  const payload: {
    title?: unknown;
    path?: unknown;
    content?: unknown;
    updatedAt?: unknown;
    totalLines?: unknown;
    truncated?: unknown;
  } | null = await state.client.request("wiki.get", {
    lookup,
    fromLine: 1,
    lineCount: 5000,
  });
  const title =
    typeof payload?.title === "string" && payload.title.trim() ? payload.title.trim() : lookup;
  const path =
    typeof payload?.path === "string" && payload.path.trim() ? payload.path.trim() : lookup;
  const content =
    typeof payload?.content === "string" && payload.content.length > 0
      ? payload.content
      : "No wiki content available.";
  const updatedAt =
    typeof payload?.updatedAt === "string" && payload.updatedAt.trim()
      ? payload.updatedAt.trim()
      : undefined;
  const totalLines =
    typeof payload?.totalLines === "number" && Number.isFinite(payload.totalLines)
      ? Math.max(0, Math.floor(payload.totalLines))
      : undefined;
  const truncated = payload?.truncated === true;
  return {
    title,
    path,
    content,
    ...(totalLines !== undefined ? { totalLines } : {}),
    ...(truncated ? { truncated } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function applyDreamingEnabled(state: AppViewState, enabled: boolean, dreamingOn: boolean) {
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
}

export async function confirmDreamingRestart(state: AppViewState, enabled: boolean) {
  state.dreamingRestartConfirmLoading = true;
  state.dreamingStatusError = null;
  try {
    const updated = await updateDreamingEnabled(state, enabled);
    if (!updated) {
      if (!state.dreamingStatusError) {
        state.dreamingStatusError = t("dreaming.restartConfirmation.failed");
      }
      return;
    }
    await loadConfig(state);
    await loadDreamingStatus(state);
    state.dreamingRestartConfirmOpen = false;
    state.dreamingPendingEnabled = null;
  } finally {
    state.dreamingRestartConfirmLoading = false;
  }
}

export function renderDreamingTab(
  state: AppViewState,
  options: {
    active: boolean;
    onRequestUpdate?: () => void;
  },
) {
  return html`
    ${renderDreaming({
      active: options.active,
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
      onRefresh: () => refreshDreaming(state),
      onRefreshDiary: () => loadDreamDiary(state),
      onRefreshImports: () => {
        void (async () => {
          await loadConfig(state);
          await loadWikiImportInsights(state);
        })();
      },
      onRefreshMemoryPalace: () => {
        void (async () => {
          await loadConfig(state);
          await loadWikiMemoryPalace(state);
        })();
      },
      onOpenConfig: () => openConfigFile(state),
      onOpenWikiPage: (lookup: string) => openWikiPage(state, lookup),
      onBackfillDiary: () => backfillDreamDiary(state),
      onCopyDreamingArchivePath: () => {
        void copyDreamingArchivePath(state);
      },
      onDedupeDreamDiary: () => dedupeDreamDiary(state),
      onResetDiary: () => resetDreamDiary(state),
      onResetGroundedShortTerm: () => resetGroundedShortTerm(state),
      onRepairDreamingArtifacts: () => repairDreamingArtifacts(state),
      onRequestUpdate: options.onRequestUpdate,
    })}
  `;
}
