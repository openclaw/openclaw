import type {
  DreamingEntry,
  WikiImportInsights,
  WikiOverview,
  WikiPagePreview,
} from "./dreaming.ts";

type DreamingPhaseInfo = {
  enabled: boolean;
  cron: string;
  nextRunAtMs?: number;
};

export type DreamingProps = {
  access: {
    canOpenConfig: boolean;
    canBackfillDiary: boolean;
    canDedupeDreamDiary: boolean;
    canResetDiary: boolean;
    canResetGroundedShortTerm: boolean;
    canRepairDreamingArtifacts: boolean;
  };
  viewState: DreamingViewState;
  active: boolean;
  selectedAgentId: string;
  shortTermCount: number;
  promotedCount: number;
  phases?: {
    light: DreamingPhaseInfo;
    deep: DreamingPhaseInfo;
    rem: DreamingPhaseInfo;
  };
  shortTermEntries: DreamingEntry[];
  promotedEntries: DreamingEntry[];
  nextCycle: string | null;
  timezone: string | null;
  statusError: string | null;
  modeSaving: boolean;
  dreamDiaryLoading: boolean;
  dreamDiaryActionLoading: boolean;
  dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null;
  dreamDiaryActionArchivePath: string | null;
  dreamDiaryError: string | null;
  dreamDiaryContent: string | null;
  memoryWikiEnabled: boolean;
  wikiImportInsightsLoading: boolean;
  wikiImportInsightsError: string | null;
  wikiImportInsights: WikiImportInsights | null;
  wikiOverviewLoading: boolean;
  wikiOverviewError: string | null;
  wikiOverview: WikiOverview | null;
  onRefreshDiary: () => void;
  onRefreshImports: () => void;
  onRefreshWikiOverview: () => void;
  onOpenConfig: () => void;
  onOpenWikiPage: (lookup: string) => Promise<WikiPagePreview | null>;
  onBackfillDiary: () => void;
  onCopyDreamingArchivePath: () => void;
  onDedupeDreamDiary: () => void;
  onResetDiary: () => void;
  onResetGroundedShortTerm: () => void;
  onRepairDreamingArtifacts: () => void;
  onViewStateChange: () => void;
};

export type DreamingViewState = {
  dreamIndex: number;
  dreamLastSwap: number;
  activeSubTab: "scene" | "diary" | "advanced";
  activeDiarySubTab: "dreams" | "insights" | "wiki";
  advancedWaitingSort: "recent" | "signals";
  expandedInsightCards: Set<string>;
  expandedWikiCards: Set<string>;
  diaryPage: number;
  wikiPreview: { page: WikiPagePreview; loading: boolean; error: string | null } | null;
};
