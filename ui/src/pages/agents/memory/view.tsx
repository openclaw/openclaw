import { createMemo, untrack } from "solid-js";
import { renderHubTabs } from "../../../components/hub-tabs.ts";
import { LitContent } from "../../../components/solid/lit-content.tsx";
import { registerDreamingEnglish } from "../../../i18n/locales/en-dreaming.ts";
import { registerSettingsEnglish } from "../../../i18n/locales/en-settings.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/dreams.css";
import type {
  DreamingEntry,
  WikiImportInsights,
  WikiOverview,
  WikiPagePreview,
} from "./dreaming.ts";
import { renderAdvancedSection } from "./view-advanced.tsx";
import { renderDiarySection } from "./view-diary.tsx";
import { renderScene } from "./view-scene.tsx";

registerSettingsEnglish();
registerDreamingEnglish();

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

const DREAM_PHRASE_KEYS = [
  "dreaming.phrases.consolidatingMemories",
  "dreaming.phrases.tidyingKnowledgeGraph",
  "dreaming.phrases.replayingConversations",
  "dreaming.phrases.weavingShortTerm",
  "dreaming.phrases.defragmentingMemoryLane",
  "dreaming.phrases.filingLooseThoughts",
  "dreaming.phrases.connectingDots",
  "dreaming.phrases.compostingContext",
  "dreaming.phrases.alphabetizingSubconscious",
  "dreaming.phrases.promotingHunches",
  "dreaming.phrases.forgettingNoise",
  "dreaming.phrases.dreamingEmbeddings",
  "dreaming.phrases.reorganizingAttic",
  "dreaming.phrases.indexingDay",
  "dreaming.phrases.nurturingInsights",
  "dreaming.phrases.simmeringIdeas",
  "dreaming.phrases.whisperingVectorStore",
] as const;

const DREAM_SWAP_MS = 6_000;

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

export function createDreamingViewState(): DreamingViewState {
  return {
    dreamIndex: Math.floor(Math.random() * DREAM_PHRASE_KEYS.length),
    dreamLastSwap: 0,
    activeSubTab: "scene",
    activeDiarySubTab: "dreams",
    advancedWaitingSort: "recent",
    expandedInsightCards: new Set(),
    expandedWikiCards: new Set(),
    diaryPage: 0,
    wikiPreview: null,
  };
}

function currentDreamPhrase(state: DreamingViewState): string {
  const now = Date.now();
  if (now - state.dreamLastSwap > DREAM_SWAP_MS) {
    state.dreamLastSwap = now;
    state.dreamIndex = (state.dreamIndex + 1) % DREAM_PHRASE_KEYS.length;
  }
  return t(DREAM_PHRASE_KEYS[state.dreamIndex] ?? DREAM_PHRASE_KEYS[0]);
}

export function renderDreaming(props: DreamingProps) {
  const state = untrack(() => props.viewState);
  const dreamText = createMemo(() => currentDreamPhrase(state));
  const activeSubTab = createMemo(() => state.activeSubTab);

  return (
    <div class="dreams-page">
      <div class="dreams__topbar">
        <LitContent
          content={() =>
            renderHubTabs({
              id: "dreams",
              active: state.activeSubTab,
              tabs: [
                { value: "scene", label: t("dreaming.tabs.scene") },
                { value: "diary", label: t("dreaming.tabs.diary") },
                { value: "advanced", label: t("dreaming.tabs.advanced") },
              ],
              ariaLabel: t("memoryPage.tabs.dreams"),
              panelId: "dreams-panel",
              variant: "sub",
              onSelect: (tab) => {
                state.activeSubTab = tab;
                props.onViewStateChange();
              },
            })
          }
        />
      </div>

      <div
        id="dreams-panel"
        class="dreams__panel"
        role="tabpanel"
        aria-labelledby={`dreams-tab-${activeSubTab()}`}
      >
        {activeSubTab() === "scene"
          ? renderScene(props, dreamText)
          : activeSubTab() === "diary"
            ? renderDiarySection(props)
            : renderAdvancedSection(props)}
      </div>
    </div>
  );
}
