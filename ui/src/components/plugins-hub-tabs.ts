// Shared tab strip for the Plugins hub: the plugins, skills, and skill-workshop
// routes render it under one "Plugins" header so the three surfaces read as tabs
// of a single page even though each tab keeps its own route and loader.
import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";

export type PluginsHubTab = "installed" | "discover" | "skills" | "workshop";

const HUB_TABS: readonly PluginsHubTab[] = ["installed", "discover", "skills", "workshop"];

export type PluginsHubTabsProps = {
  active: PluginsHubTab;
  /** Installed-plugin count badge; omit on pages without catalog data. */
  installedCount?: number | null;
  onSelect: (tab: PluginsHubTab) => void;
};

function hubTabLabel(tab: PluginsHubTab): string {
  switch (tab) {
    case "installed":
      return t("pluginsPage.installedTab");
    case "discover":
      return t("pluginsPage.discoverTab");
    case "skills":
      return t("tabs.skills");
    case "workshop":
      return t("pluginsPage.workshopTab");
    default:
      return tab satisfies never;
  }
}

function handleHubTabKeydown(
  event: KeyboardEvent,
  tab: PluginsHubTab,
  onSelect: PluginsHubTabsProps["onSelect"],
) {
  const currentIndex = HUB_TABS.indexOf(tab);
  let nextIndex: number;
  switch (event.key) {
    case "ArrowRight":
      nextIndex = (currentIndex + 1) % HUB_TABS.length;
      break;
    case "ArrowLeft":
      nextIndex = (currentIndex - 1 + HUB_TABS.length) % HUB_TABS.length;
      break;
    case "Home":
      nextIndex = 0;
      break;
    case "End":
      nextIndex = HUB_TABS.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  const nextTab = HUB_TABS[nextIndex];
  if (!nextTab) {
    return;
  }
  onSelect(nextTab);
  const tablist = (event.currentTarget as HTMLElement).closest('[role="tablist"]');
  tablist?.querySelector<HTMLElement>(`#plugins-tab-${nextTab}`)?.focus();
}

/**
 * Every hub page marks its main content container with
 * id="plugins-hub-panel" so aria-controls stays valid on each route.
 */
export function renderPluginsHubTabs(props: PluginsHubTabsProps) {
  return html`
    <div class="plugins-tabs" role="tablist" aria-label=${t("pluginsPage.hubTablistLabel")}>
      ${HUB_TABS.map((tab) => {
        const selected = props.active === tab;
        const count = tab === "installed" ? (props.installedCount ?? null) : null;
        return html`
          <button
            id=${`plugins-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected=${selected ? "true" : "false"}
            aria-controls="plugins-hub-panel"
            .tabIndex=${selected ? 0 : -1}
            class=${selected ? "active" : ""}
            @click=${() => props.onSelect(tab)}
            @keydown=${(event: KeyboardEvent) => handleHubTabKeydown(event, tab, props.onSelect)}
          >
            ${hubTabLabel(tab)} ${count === null ? nothing : html`<span>${count}</span>`}
          </button>
        `;
      })}
    </div>
  `;
}
