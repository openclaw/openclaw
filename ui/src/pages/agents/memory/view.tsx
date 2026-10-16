import { createMemo } from "solid-js";
import { HubTabs } from "../../../components/solid/hub-tabs.tsx";
import { registerDreamingEnglish } from "../../../i18n/locales/en-dreaming.ts";
import { registerSettingsEnglish } from "../../../i18n/locales/en-settings.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/dreams.css";
import { renderAdvancedSection } from "./view-advanced.tsx";
import { renderDiarySection } from "./view-diary.tsx";
import { renderScene } from "./view-scene.tsx";
import type { DreamingProps, DreamingViewState } from "./view-types.ts";

export type { DreamingProps, DreamingViewState } from "./view-types.ts";

registerSettingsEnglish();
registerDreamingEnglish();

export const DREAM_PHRASE_KEYS = [
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

export function createDreamingViewState(): DreamingViewState {
  return {
    dreamIndex: Math.floor(Math.random() * DREAM_PHRASE_KEYS.length),
    dreamLastSwap: 0,
    activeSubTab: "scene",
    activeDiarySubTab: "dreams",
    advancedWaitingSort: "recent",
    expandedInsightCards: {},
    expandedWikiCards: {},
    diaryPage: 0,
  };
}

export function renderDreaming(props: DreamingProps) {
  const state = () => props.viewState;
  const dreamText = () => t(DREAM_PHRASE_KEYS[state().dreamIndex] ?? DREAM_PHRASE_KEYS[0]);
  const activeSubTab = createMemo(() => state().activeSubTab);

  return (
    <div class="dreams-page">
      <div class="dreams__topbar">
        <HubTabs<DreamingViewState["activeSubTab"]>
          {...{
            id: "dreams",
            active: state().activeSubTab,
            tabs: [
              { value: "scene", label: t("dreaming.tabs.scene") },
              { value: "diary", label: t("dreaming.tabs.diary") },
              { value: "advanced", label: t("dreaming.tabs.advanced") },
            ],
            ariaLabel: t("memoryPage.tabs.dreams"),
            panelId: "dreams-panel",
            variant: "sub",
            onSelect: (tab) => {
              props.onViewStateChange((draft) => {
                draft.activeSubTab = tab;
              });
            },
          }}
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
