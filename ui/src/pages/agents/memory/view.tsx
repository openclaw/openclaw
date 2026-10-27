import { Match, Switch } from "solid-js";
import { HubTabs } from "../../../components/solid/hub-tabs.tsx";
import { registerDreamingEnglish } from "../../../i18n/locales/en-dreaming.ts";
import { registerSettingsEnglish } from "../../../i18n/locales/en-settings.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import "../../../styles/dreams.css";
import type { DreamingViewState } from "./dreaming.ts";
import { DreamingAdvancedSection } from "./view-advanced.tsx";
import { DreamingDiarySection } from "./view-diary.tsx";
import { DreamingScene } from "./view-scene.tsx";
import type { DreamingProps } from "./view-types.ts";

registerSettingsEnglish();
registerDreamingEnglish();

export function renderDreaming(props: DreamingProps) {
  const state = () => props.viewState;
  const activeSubTab = () => state().activeSubTab;

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
        <Switch fallback={<DreamingAdvancedSection {...props} />}>
          <Match when={activeSubTab() === "scene"}>
            <DreamingScene {...props} />
          </Match>
          <Match when={activeSubTab() === "diary"}>
            <DreamingDiarySection {...props} />
          </Match>
        </Switch>
      </div>
    </div>
  );
}
