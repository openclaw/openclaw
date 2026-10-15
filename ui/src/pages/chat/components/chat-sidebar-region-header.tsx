import { Show, createMemo, createUniqueId } from "solid-js";
import { beginNativeWindowDrag } from "../../../app/native-window-drag.ts";
import { readPanelHostedTabs, type PanelHostedTab } from "../../../components/panel-hosted-tabs.ts";
import {
  PanelTabStrip,
  type SolidPanelTabStripTab,
} from "../../../components/panel-tab-strip-solid.tsx";
import {
  BROWSER_PANEL_TOGGLE_EVENT,
  LINK_READER_PANEL_TOGGLE_EVENT,
  TERMINAL_PANEL_TOGGLE_EVENT,
} from "../../../components/panel-toggle-contract.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { KeyboardShortcut } from "../../../components/solid/kbd.tsx";
import { Menu, type MenuItem } from "../../../components/solid/menu.tsx";
import "../../../components/tooltip.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { LitContent, emptyLegacyContent } from "../../../lit/solid-content.tsx";
import { readLinkFavicon } from "../link-favicon-cache.ts";
import {
  sidebarActivePanel,
  sidebarSidePanels,
  type SidebarPanel,
  type SidebarSlotId,
} from "../sidebar-layout.ts";
import type {
  SidebarPanelDefinition,
  RegionProps,
  RegionElement,
} from "./chat-sidebar-region-types.ts";

type SidebarRegionHeaderProps = RegionProps & {
  host: RegionElement;
  hostedRevision: () => number;
  refreshHostedTabs: () => void;
};

export function readRegionPanelHost(host: HTMLElement, slot: SidebarSlotId): Element | null {
  const container = host.parentElement?.querySelector(`[data-panel-slot="${slot}"]`);
  // Native panel views have an interop wrapper; raw plugin content still owns its first element.
  return (
    container?.querySelector("[data-sidebar-panel-host]") ?? container?.firstElementChild ?? null
  );
}

export function readRegionHostedTabs(host: HTMLElement, panel: SidebarPanel) {
  return readPanelHostedTabs(readRegionPanelHost(host, panel.slot));
}

export function sidebarPanelType(definitions: SidebarPanelDefinition[], slot: SidebarSlotId) {
  const definition = definitions.find((candidate) => candidate.slot === slot);
  if (!definition) {
    throw new Error(`Missing sidebar panel definition for ${slot}`);
  }
  return definition;
}

export function PanelTypeOption(props: { type: SidebarPanelDefinition; slotted?: boolean }) {
  return (
    <>
      <span
        slot={props.slotted ? "icon" : undefined}
        class="side-panel-type-option__icon"
        aria-hidden="true"
      >
        <LitContent value={props.type.icon} />
      </span>
      <span class="side-panel-type-option__label">{props.type.label}</span>{" "}
      <Show when={props.type.shortcut}>
        {(shortcut) => (
          <KeyboardShortcut
            combo={shortcut()}
            slot={props.slotted ? "details" : undefined}
            class="side-panel-type-option__shortcut"
          />
        )}
      </Show>
    </>
  );
}

const HOSTED_TAB_REQUESTS = [
  ["browser", BROWSER_PANEL_TOGGLE_EVENT, { open: true, newTab: true }],
  ["link-reader", LINK_READER_PANEL_TOGGLE_EVENT, { open: true, newTab: true }],
  ["terminal", TERMINAL_PANEL_TOGGLE_EVENT, { open: true, newSession: true }],
] as const;

function TypeMenu(props: SidebarRegionHeaderProps) {
  const id = createUniqueId();
  const openSlots = () =>
    new Set((props.layout.columns[0]?.panels ?? []).map((panel) => panel.slot));
  const items = createMemo<MenuItem[]>(() =>
    props.panelDefinitions
      .filter(
        (type) =>
          type.available &&
          (HOSTED_TAB_REQUESTS.some(([slot]) => slot === type.slot) || !openSlots().has(type.slot)),
      )
      .map((type) => ({
        id: type.slot,
        label: type.label,
        class: "side-panel-type-menu__item session-menu__item",
        content: <PanelTypeOption type={type} />,
      })),
  );
  return (
    <Menu
      lazy
      id={`side-panel-type-${id}`}
      class="side-panel-type-menu"
      panelClass="side-panel-type-menu__panel"
      triggerClass="rail-header__action side-panel-type-menu__trigger"
      triggerAttributes={{ title: t("chat.sidePanel.addTab") }}
      placement="bottom-start"
      label={t("chat.sidePanel.addTab")}
      trigger={<Icon name="plus" />}
      items={items()}
      onSelect={(item) => {
        const slot = props.panelDefinitions.find(
          (type) => type.available && type.slot === item.id,
        )?.slot;
        if (!slot) {
          return;
        }
        const alreadyOpen = openSlots().has(slot);
        props.callbacks?.openSlot(slot);
        const request = HOSTED_TAB_REQUESTS.find(([panel]) => panel === slot);
        if (request && alreadyOpen) {
          props.host.deliverPanelEvent(
            slot,
            new CustomEvent(request[1], { detail: { ...request[2] } }),
          );
        }
      }}
    />
  );
}
function HostedIcon(props: SidebarRegionHeaderProps & { tab: PanelHostedTab }) {
  const favicon = () => {
    props.hostedRevision();
    if (props.tab.favicon) {
      return props.tab.favicon;
    }
    const hostname = props.tab.url ? URL.parse(props.tab.url)?.hostname : "";
    return hostname && props.fetchFavicon
      ? readLinkFavicon(hostname, props.fetchFavicon, props.refreshHostedTabs)
      : null;
  };
  return (
    <Show when={favicon()} fallback={<LitContent value={props.tab.icon} />}>
      {(src) => <img class="tabstrip-tab__favicon" src={src()} alt="" />}
    </Show>
  );
}
export function SidebarRegionHeader(props: SidebarRegionHeaderProps) {
  const state = createMemo(() => {
    props.hostedRevision();
    const column = props.layout.columns[0];
    const panels = sidebarSidePanels(props.layout);
    const hostedPanels = panels.flatMap((panel) => {
      const element = readRegionHostedTabs(props.host, panel);
      return element ? [{ panel, element, tabs: element.hostedTabs }] : [];
    });
    const resolveHostedTab = (id: string) => {
      for (const hosted of hostedPanels) {
        const prefix = `hosted:${hosted.panel.id}:`;
        if (id.startsWith(prefix)) {
          const tabId = id.slice(prefix.length);
          if (hosted.tabs.some((tab) => tab.id === tabId)) {
            return { ...hosted, tabId };
          }
        }
      }
      return null;
    };
    const tabs = panels.flatMap((panel): (SolidPanelTabStripTab & { contentId: string })[] => {
      const contentId = `${props.panelIdPrefix}-${encodeURIComponent(panel.slot)}`;
      const canRestore =
        props.layout.expanded &&
        props.layout.expandedSide &&
        !props.sideFocusLocked &&
        column?.activePanelId === panel.id;
      const hosted = hostedPanels.find((entry) => entry.panel.id === panel.id);
      if (hosted?.tabs.length) {
        return hosted.tabs.map((tab) => ({
          id: `hosted:${panel.id}:${tab.id}`,
          domId: `${props.panelIdPrefix}-tab-${encodeURIComponent(JSON.stringify([panel.id, tab.id]))}`,
          contentId,
          label: tab.label,
          labelTooltip: tab.label,
          title: tab.title,
          icon: <HostedIcon {...props} tab={tab} />,
          statusLabel: tab.statusLabel,
          badge: tab.badge,
          className: tab.className,
          closeLabel: `${t("browser.closeTab")}: ${tab.label}`,
          group: panel.id,
          draggable: false,
          reorderId: panel.id,
          onActivate:
            canRestore && tab.id === hosted.element.activeHostedTabId
              ? () => props.callbacks?.togglePanelExpanded(panel.id)
              : undefined,
        }));
      }
      const type = sidebarPanelType(props.panelDefinitions, panel.slot);
      const tab =
        panel.slot === "conversation" && props.conversationTab?.label
          ? props.conversationTab
          : type;
      return [
        {
          id: panel.id,
          domId: `${props.panelIdPrefix}-tab-${encodeURIComponent(panel.id)}`,
          contentId,
          label: tab.label,
          labelTooltip:
            panel.slot === "dashboard" || canRestore
              ? t(
                  props.layout.expanded &&
                    props.layout.expandedSide &&
                    column?.activePanelId === panel.id
                    ? "chat.sidePanel.restore"
                    : "chat.sidePanel.expandPanel",
                  { panel: type.label },
                )
              : tab.label,
          onActivate:
            panel.slot === "dashboard" || canRestore
              ? () => props.callbacks?.togglePanelExpanded(panel.id)
              : undefined,
          icon: <LitContent value={tab.icon} />,
          closeLabel: t("chat.sidebarColumns.close", { panel: type.label }),
        },
      ];
    });
    const active = sidebarActivePanel(props.layout);
    const activeHosted = hostedPanels.find((entry) => entry.panel.id === active?.id);
    const activeId = activeHosted?.tabs.some(
      (tab) => tab.id === activeHosted.element.activeHostedTabId,
    )
      ? `hosted:${activeHosted.panel.id}:${activeHosted.element.activeHostedTabId}`
      : (active?.id ?? null);
    return { tabs, activeId, active, activeHosted, resolveHostedTab, column };
  });
  const hostedActions = () => state().activeHosted?.element.hostedActions ?? emptyLegacyContent;
  return (
    <header
      class="rail-header side-panel__header"
      data-region-header="side"
      onMouseDown={beginNativeWindowDrag}
    >
      <div class="side-panel__header-tabs">
        <PanelTabStrip
          tabs={state().tabs}
          activeId={state().activeId}
          ariaControls={(tab) => tab.contentId}
          onSelect={(id) => {
            const hosted = state().resolveHostedTab(id);
            if (hosted) {
              if (state().column?.activePanelId !== hosted.panel.id) {
                props.callbacks?.activatePanel(hosted.panel.id);
              }
              hosted.element.selectHostedTab(hosted.tabId);
            } else {
              props.callbacks?.activatePanel(id);
            }
          }}
          onClose={(id) => {
            const hosted = state().resolveHostedTab(id);
            if (hosted) {
              return hosted.element.closeHostedTab(hosted.tabId);
            }
            const panel = state().column?.panels.find((entry) => entry.id === id);
            if (panel) {
              props.callbacks?.closeSlot(panel.slot);
            }
            return undefined;
          }}
          onNew={() => undefined}
          newLabel={t("chat.sidePanel.addTab")}
          newControl={null}
          separateTabs
          onReorder={(source, target, placement) =>
            props.callbacks?.reorderPanel(source, target, placement)
          }
        />
        <TypeMenu {...props} />
      </div>
      <Show when={hostedActions() !== emptyLegacyContent}>
        <div class="rail-header__actions side-panel__actions">
          <LitContent value={hostedActions()} />
        </div>
      </Show>
    </header>
  );
}
