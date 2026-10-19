import type { WikiPagePreview } from "./dreaming.ts";
import type { AgentMemoryState } from "./memory-panel-state.ts";

type DreamingPhaseInfo = {
  enabled: boolean;
  cron: string;
  nextRunAtMs?: number;
};

export type WikiPreviewState = { page: WikiPagePreview; loading: boolean; error: string | null };

type DreamingOwnerProps = ReturnType<AgentMemoryState["view"]>["dreaming"];
export type DreamingProps = Omit<DreamingOwnerProps, "phases"> & {
  phases?: Record<keyof NonNullable<DreamingOwnerProps["phases"]>, DreamingPhaseInfo>;
};

export type DreamingViewState = {
  dreamIndex: number;
  dreamLastSwap: number;
  activeSubTab: "scene" | "diary" | "advanced";
  activeDiarySubTab: "dreams" | "insights" | "wiki";
  advancedWaitingSort: "recent" | "signals";
  expandedInsightCards: Record<string, boolean>;
  expandedWikiCards: Record<string, boolean>;
  diaryPage: number;
};
