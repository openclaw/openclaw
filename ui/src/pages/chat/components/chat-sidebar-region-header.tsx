import { For, Show, createMemo, createUniqueId, createSignal, onSettled, mapArray } from "solid-js";
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
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import { AgentIdentityAvatar } from "../../../components/solid/identity-avatar.tsx";
import { KeyboardShortcut } from "../../../components/solid/kbd.tsx";
import { Menu, type MenuItem } from "../../../components/solid/menu.tsx";
import { createTextOverflow } from "../../../components/solid/text-overflow.ts";
import "../../../components/tooltip.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import type { AgentIdentity } from "../../../lib/identity-avatar-view.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { TabFocus } from "../../../lib/tabs.ts";
import { showToast } from "../../../lib/toast.ts";
import { readLinkFavicon } from "../link-favicon-cache.ts";
import {
  sidebarActivePanel,
  sidebarSidePanels,
  sidebarSideTabIds,
  isSidebarNewTabActive,
  type SidebarPanel,
  type SidebarSlotId,
} from "../sidebar-layout.ts";
import { ChatPanelHeaderActions } from "./chat-header-panel-actions.tsx";
import { DesktopFrameControls } from "./chat-sidebar-desktop-frame-controls.tsx";
import type {
  SidebarPanelDefinition,
  RegionProps,
  RegionElement,
} from "./chat-sidebar-region-types.ts";

/** Complete a single close without interfering with Close all's retained launcher. */
export function closeEmptyMobileHost(
  props: Pick<RegionProps, "mobileHost" | "layout">,
  scopeKey: string | undefined,
): boolean {
  if (
    !props.mobileHost ||
    props.mobileHost.scopeKey !== scopeKey ||
    props.mobileHost.destination.area !== "panels" ||
    props.mobileHost.destination.page ||
    sidebarSidePanels(props.layout).length ||
    props.layout.newTab
  ) {
    return false;
  }
  props.mobileHost.close();
  return true;
}

type SidebarRegionHeaderProps = RegionProps & {
  host: RegionElement;
  onOpenMobileLauncher?: () => void;
  hostedRevision: () => number;
  refreshHostedTabs: () => void;
  headerRef: (element: HTMLElement | null) => void;
  tabFocus: TabFocus;
};

type RegionTab = SolidPanelTabStripTab & {
  contentId: string;
  hostedTab?: PanelHostedTab;
  conversationAvatar?: AgentIdentity;
  iconName?: IconName;
};

export function readRegionHostedTabs(host: RegionElement, panel: SidebarPanel) {
  return readPanelHostedTabs(host.readPanelHost(panel.slot));
}

export function sidebarPanelType(definitions: SidebarPanelDefinition[], slot: SidebarSlotId) {
  const definition = definitions.find((candidate) => candidate.slot === slot);
  if (!definition) {
    throw new Error(`Missing sidebar panel definition for ${slot}`);
  }
  return definition;
}

export function PanelTypeOption(props: { type: SidebarPanelDefinition }) {
  return (
    <>
      <span class="side-panel-type-option__icon" aria-hidden="true">
        <Icon name={props.type.icon} />
      </span>
      <span
        ref={createTextOverflow(() => props.type.label)}
        class="side-panel-type-option__label"
        title={props.type.label}
      >
        {props.type.label}
      </span>{" "}
      <Show when={props.type.shortcut}>
        {(shortcut) => (
          <KeyboardShortcut combo={shortcut()} class="side-panel-type-option__shortcut" />
        )}
      </Show>
    </>
  );
}

/** Catalog projection only: native availability and open operations remain with the pane. */
export function SidebarPanelLauncher(props: {
  definitions: SidebarPanelDefinition[];
  onOpen: (slot: SidebarSlotId) => void;
}) {
  const quickSlots: SidebarSlotId[] = ["companion", "workspace", "browser"];
  const exploreSlots: SidebarSlotId[] = [
    "detail",
    "link-reader",
    "dashboard",
    "subagents",
    "processes",
    "terminal",
    "desktop",
    "portal",
  ];
  const available = () =>
    props.definitions.filter((type) => type.available && type.slot !== "conversation");
  const quick = () =>
    quickSlots.flatMap((slot) =>
      props.definitions.filter(
        (type) => type.slot === slot && (type.available || slot === "browser"),
      ),
    );
  const explore = () => [
    ...exploreSlots.flatMap((slot) => available().filter((type) => type.slot === slot)),
    ...available().filter(
      (type) => !quickSlots.includes(type.slot) && !exploreSlots.includes(type.slot),
    ),
  ];
  return (
    <div class="side-panel-launcher">
      <div class="side-panel-launcher__content">
        <Show when={quick().length > 0}>
          <div class="side-panel-launcher__heading">{t("chat.sidePanel.quickAccess")}</div>
          <div class="side-panel-launcher__quick">
            <For each={quick()} keyed={(type) => type.slot}>
              {(type) => (
                <openclaw-tooltip prop:content={type().unavailableReason}>
                  <button
                    type="button"
                    class="side-panel-launcher__card"
                    aria-disabled={!type().available ? "true" : undefined}
                    onClick={() => {
                      if (type().available) {
                        props.onOpen(type().slot);
                      }
                    }}
                  >
                    <PanelTypeOption type={type()} />
                  </button>
                </openclaw-tooltip>
              )}
            </For>
          </div>
        </Show>
        <Show when={explore().length > 0}>
          <div class="side-panel-launcher__heading">{t("chat.sidePanel.explorePanels")}</div>
          <div class="side-panel-launcher__explore">
            <For each={explore()} keyed={(type) => type.slot}>
              {(type) => (
                <button
                  type="button"
                  class="side-panel-launcher__item"
                  onClick={() => props.onOpen(type().slot)}
                >
                  <PanelTypeOption type={type()} />
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
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
  const types = () =>
    props.panelDefinitions.filter(
      (type) =>
        type.available &&
        (HOSTED_TAB_REQUESTS.some(([slot]) => slot === type.slot) || !openSlots().has(type.slot)),
    );
  const entries = createMemo(
    () =>
      mapArray(
        types,
        (current): MenuItem => ({
          get id() {
            return current().slot;
          },
          get label() {
            return current().label;
          },
          class: "side-panel-type-menu__item session-menu__item",
          icon: <Icon name={current().icon} class="side-panel-type-option__icon" />,
          labelClass: "side-panel-type-option__label",
          content: (
            <span
              ref={createTextOverflow(() => current().label)}
              style="display:block;overflow:hidden"
              title={current().label}
            >
              {current().label}
            </span>
          ),
          details: (
            <Show when={current().shortcut}>
              {(shortcut) => (
                <KeyboardShortcut combo={shortcut()} class="side-panel-type-option__shortcut" />
              )}
            </Show>
          ),
        }),
        { keyed: (type) => type.slot },
      ),
    { lazy: true },
  );
  return (
    <Menu
      lazy="while-open"
      id={`side-panel-type-${id}`}
      class="side-panel-type-menu"
      panelClass="side-panel-type-menu__panel"
      triggerClass="rail-header__action side-panel-type-menu__trigger"
      triggerAttributes={{ title: t("chat.sidePanel.addTab") }}
      placement="bottom-start"
      label={t("chat.sidePanel.addTab")}
      trigger={<Icon name="plus" />}
      items={entries()()}
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
    <Show when={favicon()} fallback={props.tab.icon}>
      {(src) => <img class="tabstrip-tab__favicon" src={src()} alt="" />}
    </Show>
  );
}

export function SidebarRegionHeader(props: SidebarRegionHeaderProps) {
  const desktop = () => props.presentation === "desktop";
  const panelScope = createMemo(() => props.panelIdPrefix);
  const mobileHostScope = createMemo(() => props.mobileHost?.scopeKey);
  const closeScope = createMemo(() => {
    const initialScope = panelScope();
    const initialMobileScope = mobileHostScope();
    const [closing, setClosing] = createSignal(false);
    return {
      closing,
      setClosing,
      current: () =>
        props.host.isConnected &&
        props.host.panelIdPrefix === initialScope &&
        props.host.mobileHost?.scopeKey === initialMobileScope,
    };
  });
  const closing = () => closeScope().closing();
  let activeClose: ReturnType<typeof closeScope> | undefined;
  const state = createMemo(() => {
    props.hostedRevision();
    const column = props.layout.columns[0];
    const sidePanels = sidebarSidePanels(props.layout);
    const panels = desktop()
      ? [
          ...sidePanels.filter((panel) => panel.slot === "conversation"),
          ...sidePanels.filter((panel) => panel.slot !== "conversation"),
        ]
      : sidePanels;
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
    const order = sidebarSideTabIds(props.layout);
    const chat = panels.find((panel) => panel.slot === "conversation");
    const tabIds = desktop() && chat ? [chat.id, ...order.filter((id) => id !== chat.id)] : order;
    const tabs = tabIds.flatMap((id): RegionTab[] => {
      if (id === props.layout.newTab?.id) {
        return [
          {
            id,
            domId: `${props.panelIdPrefix}-tab-new`,
            contentId: `${props.panelIdPrefix}-new-tab`,
            label: t("browser.newTab"),
            closeLabel: t("chat.sidePanel.closeNewTab"),
            iconName: "plus",
          },
        ];
      }
      const panel = panels.find((entry) => entry.id === id);
      if (!panel) {
        return [];
      }
      const contentId = `${props.panelIdPrefix}-${encodeURIComponent(panel.slot)}`;
      const canRestore =
        !desktop() &&
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
          hostedTab: tab,
          statusLabel: tab.statusLabel,
          badge: tab.badge,
          className: tab.className,
          closeLabel: `${t("browser.closeTab")}: ${tab.label}`,
          closeDisabled: tab.closeDisabled,
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
      const conversation =
        panel.slot === "conversation" && props.conversationTab?.label
          ? props.conversationTab
          : undefined;
      const tab = conversation ?? type;
      const activatesExpansion = !desktop() && (panel.slot === "dashboard" || canRestore);
      return [
        {
          id: panel.id,
          domId: `${props.panelIdPrefix}-tab-${encodeURIComponent(panel.id)}`,
          contentId,
          label: tab.label,
          labelTooltip: activatesExpansion
            ? t(
                props.layout.expanded &&
                  props.layout.expandedSide &&
                  column?.activePanelId === panel.id
                  ? "chat.sidePanel.restore"
                  : "chat.sidePanel.expandPanel",
                { panel: type.label },
              )
            : tab.label,
          onActivate: activatesExpansion
            ? () => props.callbacks?.togglePanelExpanded(panel.id)
            : undefined,
          conversationAvatar: conversation?.avatar,
          iconName: conversation ? undefined : type.icon,
          closeLabel: t("chat.sidebarColumns.close", { panel: type.label }),
          closable: !(desktop() && panel.slot === "conversation"),
          draggable: !(desktop() && panel.slot === "conversation"),
        },
      ];
    });
    const active = sidebarActivePanel(props.layout);
    const activeHosted = hostedPanels.find((entry) => entry.panel.id === active?.id);
    const activeId = isSidebarNewTabActive(props.layout)
      ? props.layout.newTab!.id
      : activeHosted?.tabs.some((tab) => tab.id === activeHosted.element.activeHostedTabId)
        ? `hosted:${activeHosted.panel.id}:${activeHosted.element.activeHostedTabId}`
        : (active?.id ?? null);
    return { tabs, activeId, active, activeHosted, resolveHostedTab, column };
  });
  const settle = async () => {
    await new Promise<void>((resolve) => {
      onSettled(resolve);
    });
    await props.host.updateComplete;
    props.refreshHostedTabs();
    await new Promise<void>((resolve) => {
      onSettled(resolve);
    });
  };
  const hasPanel = (id: string) => props.layout.columns[0]?.panels.some((panel) => panel.id === id);
  async function closeTab(id: string): Promise<boolean> {
    const scope = props.panelIdPrefix;
    const mobileScope = props.mobileHost?.scopeKey;
    const current = () =>
      props.host.isConnected &&
      props.host.panelIdPrefix === scope &&
      props.host.mobileHost?.scopeKey === mobileScope;
    if (!current()) {
      return false;
    }
    if (id === props.layout.newTab?.id) {
      props.callbacks?.newTab?.close();
      await settle();
      return current() && props.layout.newTab?.id !== id;
    }
    const hosted = state().resolveHostedTab(id);
    if (hosted) {
      await hosted.element.closeHostedTab(hosted.tabId);
      if (!current()) {
        return false;
      }
      await settle();
      if (
        !current() ||
        (hasPanel(hosted.panel.id) &&
          readRegionHostedTabs(props.host, hosted.panel) !== hosted.element)
      ) {
        return false;
      }
      if (
        hasPanel(hosted.panel.id) &&
        hosted.element.hostedTabs.some((tab) => tab.id === hosted.tabId)
      ) {
        return false;
      }
      if (
        (desktop() || props.mobileHost) &&
        hasPanel(hosted.panel.id) &&
        hosted.element.hostedTabs.length === 0
      ) {
        props.callbacks?.closeSlot(hosted.panel.slot);
        await settle();
      }
      return true;
    }
    const panel = props.layout.columns[0]?.panels.find((entry) => entry.id === id);
    if (!panel) {
      return true;
    }
    if (desktop() && panel.slot === "conversation") {
      return false;
    }
    if (desktop() && panel.slot === "companion") {
      const clear = props.panelDefinitions.find((definition) => definition.slot === "companion")
        ?.view?.onClearCompanion;
      if (!clear || !(await clear()) || !current() || !hasPanel(panel.id)) {
        return false;
      }
    }
    props.callbacks?.closeSlot(panel.slot);
    await settle();
    return !hasPanel(panel.id);
  }
  async function closeAll() {
    const view = closeScope();
    if (activeClose?.current() || !view.current() || !props.callbacks?.newTab) {
      return;
    }
    activeClose = view;
    // This owner must publish and settle every close before admitting the next one.
    // Keeping its busy state outside an action lets those intermediate commits finish.
    view.setClosing(true);
    const current = view.current;
    try {
      const panels = sidebarSidePanels(props.layout).filter(
        (panel) => panel.slot !== "conversation",
      );
      for (const panel of panels) {
        if (!current()) {
          return;
        }
        if (!hasPanel(panel.id)) {
          continue;
        }
        const hosted = readRegionHostedTabs(props.host, panel);
        for (const tab of hosted?.hostedTabs ?? []) {
          if (!(await closeTab(`hosted:${panel.id}:${tab.id}`))) {
            return;
          }
        }
        if (hasPanel(panel.id)) {
          // A resource created while another close was being confirmed was not in this request.
          if (readRegionHostedTabs(props.host, panel)?.hostedTabs.length) {
            return;
          }
          if (!(await closeTab(panel.id))) {
            return;
          }
        }
      }
      // The owner refuses completion if another resource appeared during confirmation.
      if (!current()) {
        return;
      }
      props.callbacks?.newTab?.finishCloseAll();
    } catch (error) {
      showToast({ message: formatUiError(error) });
    } finally {
      if (activeClose === view) {
        activeClose = undefined;
      }
      if (view.current()) {
        view.setClosing(false);
      }
    }
  }
  const hostedActions = () =>
    ((desktop() || props.mobileHost) && state().active?.slot === "workspace") ||
    (props.mobileHost && state().active?.slot === "terminal")
      ? undefined
      : state().activeHosted?.element.hostedActions;
  const activeDefinition = createMemo(() => {
    if (
      !desktop() ||
      !props.layout.open ||
      (props.layout.expanded && !props.layout.expandedSide) ||
      isSidebarNewTabActive(props.layout)
    ) {
      return undefined;
    }
    const slot = state().active?.slot;
    return props.panelDefinitions.find((definition) => definition.slot === slot);
  });
  return (
    <header
      ref={[
        elementRef<HTMLElement>((element) => {
          props.headerRef(element);
          return () => props.headerRef(null);
        }),
      ]}
      class={[
        "rail-header side-panel__header",
        { "side-panel__header--occupied": state().tabs.length > 0 },
      ]}
      data-region-header="side"
      onMouseDown={beginNativeWindowDrag}
    >
      <div class="side-panel__header-tabs">
        <PanelTabStrip
          focusOwner={props.tabFocus}
          presentation={props.presentation}
          renderIcon={(tab) => (
            <Show
              when={tab().hostedTab}
              fallback={
                <Show
                  when={tab().conversationAvatar}
                  fallback={<Show when={tab().iconName}>{(name) => <Icon name={name()} />}</Show>}
                >
                  {(agent) => <AgentIdentityAvatar agent={agent()} />}
                </Show>
              }
            >
              {(hosted) => <HostedIcon {...props} tab={hosted()} />}
            </Show>
          )}
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
          onClose={async (id) => {
            const scopeKey = props.mobileHost?.scopeKey;
            if (closing() || !(await closeTab(id))) {
              return;
            }
            closeEmptyMobileHost(props, scopeKey);
          }}
          onNew={() => undefined}
          newLabel={t("chat.sidePanel.addTab")}
          newControl={null}
          separateTabs
          onReorder={(source, target, placement) => {
            const chatId = state().column?.panels.find(
              (panel) => panel.slot === "conversation",
            )?.id;
            if (desktop() && (source === chatId || (target === chatId && placement === "before"))) {
              return;
            }
            props.callbacks?.reorderPanel(source, target, placement);
          }}
        />
        <Show when={!desktop() && hostedActions()}>
          <div class="rail-header__actions side-panel__actions">{hostedActions()}</div>
        </Show>
        <Show
          when={!desktop()}
          fallback={
            <Show when={state().tabs.length > 0 && props.callbacks?.newTab}>
              <button
                type="button"
                class="rail-header__action tabstrip-new"
                title={t("browser.newTab")}
                aria-label={t("browser.newTab")}
                disabled={closing()}
                onClick={() => props.callbacks?.newTab?.open()}
              >
                <Icon name="plus" />
              </button>
            </Show>
          }
        >
          <Show
            when={
              !props.mobileHost || (state().tabs.length > 0 && !isSidebarNewTabActive(props.layout))
            }
          >
            <Show when={props.onOpenMobileLauncher} fallback={<TypeMenu {...props} />}>
              <button
                type="button"
                class="rail-header__action tabstrip-new"
                title={t("browser.newTab")}
                aria-label={t("browser.newTab")}
                onClick={() => props.onOpenMobileLauncher?.()}
              >
                <Icon name="plus" />
              </button>
            </Show>
          </Show>
        </Show>
      </div>
      <Show when={desktop()}>
        <div class="rail-header__actions side-panel__actions">
          {hostedActions()}
          <Show when={desktop()}>
            <Show when={activeDefinition()}>
              {(definition) => (
                <ChatPanelHeaderActions
                  headerActionView={definition().headerActionView}
                  headerLink={definition().headerLink}
                />
              )}
            </Show>
            <DesktopFrameControls
              {...props}
              onCloseAll={closeAll}
              closing={closing()}
              closable={state().tabs.some((tab) => tab.closable !== false)}
              hasConversation={sidebarSidePanels(props.layout).some(
                (panel) => panel.slot === "conversation",
              )}
            />
          </Show>
        </div>
      </Show>
    </header>
  );
}
