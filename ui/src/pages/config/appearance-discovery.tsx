import { createSignal, Show } from "solid-js";
import { Tabs, TabPanel } from "../../components/solid/tabs.tsx";
import "../../styles/hub-tabs.css";
import { t } from "../../lib/reactive/i18n.ts";
import { AppearanceLobsterPacks } from "./appearance-lobster-packs.tsx";
import { AppearanceThemeDiscovery } from "./appearance-theme-discovery.tsx";
import type { ConfigProps } from "./view-types.ts";

type AppearanceDiscoveryProps = Pick<
  ConfigProps,
  "themeCatalog" | "theme" | "lobsterdexHref" | "onOpenLobsterdex"
>;

export function AppearanceDiscovery(props: AppearanceDiscoveryProps) {
  const [tab, setTab] = createSignal("themes");
  return (
    <div class="settings-appearance-discovery">
      <h3>{t("configView.appearance.appearanceCatalog")}</h3>
      <Tabs
        class={["hub-tabs", "hub-tabs--sub"]}
        active={tab()}
        ariaLabel={t("configView.appearance.appearanceCatalog")}
        items={[
          {
            value: "themes",
            className: "hub-tab",
            label: t("configView.appearance.catalogThemes"),
            id: "appearance-themes-tab",
            panelId: "appearance-themes-panel",
          },
          {
            value: "packs",
            className: "hub-tab",
            label: t("configView.appearance.lobsterPacks"),
            id: "appearance-packs-tab",
            panelId: "appearance-packs-panel",
          },
        ]}
        onSelect={(value) => {
          setTab(value);
        }}
      />
      <TabPanel
        id="appearance-themes-panel"
        tabId="appearance-themes-tab"
        active={tab() === "themes"}
      >
        <AppearanceThemeDiscovery themeCatalog={props.themeCatalog} theme={props.theme} />
      </TabPanel>
      <TabPanel id="appearance-packs-panel" tabId="appearance-packs-tab" active={tab() === "packs"}>
        <Show when={tab() === "packs"}>
          <AppearanceLobsterPacks
            lobsterdexHref={props.lobsterdexHref}
            onOpenLobsterdex={props.onOpenLobsterdex}
          />
        </Show>
      </TabPanel>
    </div>
  );
}
