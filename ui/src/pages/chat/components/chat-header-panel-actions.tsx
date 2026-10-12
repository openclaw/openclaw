import type WaDropdown from "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import { createMemo, For, Show } from "solid-js";
import { icons } from "../../../components/icons.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { KeyboardShortcut } from "../../../components/solid/kbd.tsx";
import type { KeyboardShortcutCombo } from "../../../lib/keyboard-shortcut-contract.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { LitContent } from "../../../lit/solid-content.tsx";
import type { ChatPageHost } from "../chat-state-host.ts";
import {
  ensureSidebarConversation,
  promoteSidebarPanel,
  setSidebarDock,
  setSidebarExpanded,
  sidebarActivePanel,
  sidebarDock,
  sidebarMainPanel,
  toggleSidebarPanelExpanded,
  type SidebarLayout,
  type SidebarSlotId,
} from "../sidebar-layout.ts";
import type { HeaderMenuQuickAction } from "./chat-header-session-menu.ts";
import type { SidebarPanelDefinition } from "./chat-sidebar-region-types.ts";

export type ChatPaneLayoutMenuProps = {
  paneId: string;
  narrow: boolean;
  actionsDisabled?: boolean;
  panelMenuActions?: (HeaderMenuQuickAction & { shortcut?: KeyboardShortcutCombo })[];
  layoutMenuActions?: HeaderMenuQuickAction[];
  sidebarLayout?: SidebarLayout;
  panelDefinitions?: SidebarPanelDefinition[];
  onLayoutChange?: ChatPageHost["updateSidebarLayout"];
  onToggleSidePanel?: () => void;
  onCloseSidePanel?: (slot: SidebarSlotId) => void;
  onOpenSplitView?: () => void;
  onSplitDown?: (paneId: string) => void;
  onSplitRight?: (paneId: string) => void;
  onClosePane?: (paneId: string) => void;
};
type LayoutAction = HeaderMenuQuickAction & {
  className?: string;
  shortcut?: KeyboardShortcutCombo;
};

function layoutModel(props: ChatPaneLayoutMenuProps) {
  const layout = props.sidebarLayout;
  const definitions = props.panelDefinitions ?? [];
  const side = layout ? sidebarActivePanel(layout) : undefined;
  const mainSlot = layout ? (sidebarMainPanel(layout)?.slot ?? "conversation") : "conversation";
  const mainDefinition = definitions.find((definition) => definition.slot === mainSlot);
  const sideDefinition = definitions.find((definition) => definition.slot === side?.slot);
  const split = layout?.open === true && !layout.expanded;
  const actions: (HeaderMenuQuickAction & {
    className?: string;
    shortcut?: KeyboardShortcutCombo;
  })[] = [];
  if (layout && props.onLayoutChange && (split || layout.expanded)) {
    actions.push({
      id: "focus",
      className: "chat-panel-focus",
      label: t(layout.expanded ? "chat.sidePanel.restore" : "chat.sidePanel.expand"),
      icon: layout.expanded ? icons.minimize : icons.maximize,
      active: layout.expanded === true,
      onActivate: () =>
        props.onLayoutChange?.(
          setSidebarExpanded(ensureSidebarConversation(layout), layout.expanded !== true),
          { dashboardPresentation: "personal" },
        ),
    });
  }
  if (layout && props.onLayoutChange && split && side && mainDefinition && sideDefinition) {
    actions.push({
      id: "swap",
      className: "chat-panel-swap",
      label: t("chat.sidePanel.swap", { main: mainDefinition.label, side: sideDefinition.label }),
      icon: icons.arrowLeftRight,
      onActivate: () => props.onLayoutChange?.(promoteSidebarPanel(layout, side.id)),
    });
  }
  if (
    layout &&
    side &&
    sideDefinition &&
    !layout.expanded &&
    !props.narrow &&
    props.onLayoutChange
  ) {
    actions.push({
      id: "expand-side-panel",
      className: "side-panel__expand",
      label: t(
        layout.expanded && layout.expandedSide
          ? "chat.sidePanel.restore"
          : "chat.sidePanel.expandPanel",
        { panel: sideDefinition.label },
      ),
      icon: layout.expanded && layout.expandedSide ? icons.minimize : icons.maximize,
      onActivate: () =>
        props.onLayoutChange?.(toggleSidebarPanelExpanded(layout, side.id), {
          dashboardPresentation: "personal",
        }),
    });
  }
  if (side && sideDefinition && props.onCloseSidePanel) {
    actions.push({
      id: "close-side-panel",
      label: t("chat.sidebarColumns.close", { panel: sideDefinition.label }),
      icon: icons.x,
      onActivate: () => props.onCloseSidePanel?.(side.slot),
    });
  }
  if (props.onToggleSidePanel) {
    actions.push({
      id: "side-panel",
      className: "chat-side-panel-toggle",
      label: t(split ? "chat.sidePanel.minimize" : "chat.sidePanel.label"),
      icon: split ? icons.panelRightClose : icons.panelRightOpen,
      active: split,
      onActivate: props.onToggleSidePanel,
    });
  }
  actions.push(...(props.layoutMenuActions ?? []));
  for (const [id, label, icon, callback] of [
    ["open-split-view", "chat.splitView.open", icons.columns2, props.onOpenSplitView],
    ["split-down", "chat.splitView.splitDown", icons.panelBottomOpen, props.onSplitDown],
    ["split-right", "chat.splitView.splitRight", icons.panelRightOpen, props.onSplitRight],
    ["close-pane", "chat.splitView.closePane", icons.x, props.onClosePane],
  ] as const) {
    if (callback && (!props.narrow || (id !== "split-down" && id !== "split-right"))) {
      actions.push({
        id,
        label: t(label),
        className: id === "open-split-view" ? "chat-open-split-view" : `chat-pane__${id}`,
        icon,
        disabled: props.actionsDisabled,
        onActivate: () =>
          id === "open-split-view" ? props.onOpenSplitView?.() : callback(props.paneId),
      });
    }
  }
  if (layout && props.onLayoutChange && !props.narrow && split) {
    for (const [dock, label, icon] of [
      ["left", "dockLeft", icons.panelLeftOpen],
      ["right", "dockRight", icons.panelRightOpen],
      ["bottom", "dockBottom", icons.panelBottomOpen],
    ] as const) {
      actions.push({
        id: `dock-${dock}`,
        label: t(`chat.sidePanel.${label}`),
        icon,
        active: sidebarDock(layout) === dock,
        onActivate: () =>
          props.onLayoutChange?.(setSidebarDock(layout, dock), { geometryOnly: true }),
      });
    }
  }
  const panelActions = props.panelMenuActions ?? [];
  const allActions = [...actions, ...panelActions];
  return {
    actions,
    panelActions,
    allActions,
    mainHeaderAction: mainDefinition?.headerAction,
    sideHeaderAction: sideDefinition?.headerAction,
  };
}
function LayoutActionItem(props: { action: LayoutAction }) {
  const command = () => {
    const action = props.action;
    return action.kind === "status" ? null : action;
  };
  return (
    <Show
      when={command()}
      fallback={
        <div class="session-menu__status" data-menu-status={props.action.id} role="note">
          <span class="session-menu__check" aria-hidden="true">
            <LitContent value={props.action.icon} />
          </span>
          <ActionLabel action={props.action} />
        </div>
      }
    >
      {(action) => (
        <wa-dropdown-item
          class={["session-menu__item", action().className]}
          value={action().id}
          aria-label={action().label}
          type={action().active === undefined ? undefined : "checkbox"}
          prop:checked={action().active ?? false}
          disabled={action().disabled}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">
            <LitContent value={action().icon} />
          </span>
          <ActionLabel action={action()} />
          <Show when={action().shortcut}>
            {(shortcut) => (
              <KeyboardShortcut
                combo={shortcut()}
                slot="details"
                class="side-panel-type-option__shortcut"
              />
            )}
          </Show>
        </wa-dropdown-item>
      )}
    </Show>
  );
}
function ActionLabel(props: { action: LayoutAction }) {
  return (
    <span class="session-menu__text">
      {props.action.label}
      <Show when={props.action.description}>
        <span class="session-menu__description">{props.action.description}</span>
      </Show>
    </span>
  );
}

export function ChatPaneLayoutMenu(props: ChatPaneLayoutMenuProps) {
  const model = createMemo(() => layoutModel(props));
  let menu!: WaDropdown;
  let pendingAction: (() => void) | undefined;
  return (
    <Show when={model().allActions.length > 0 || model().mainHeaderAction}>
      <wa-dropdown
        ref={(element) => {
          menu = element;
        }}
        class="chat-pane__layout-menu chat-panel-layout-menu"
        placement="bottom-end"
        onWa-select={(event) => {
          const action = model().allActions.find(
            (candidate) => candidate.id === event.detail.item.value,
          );
          if (action && action.kind !== "status" && !action.disabled) {
            event.preventDefault();
            pendingAction = action.onActivate;
            // Settle opening first; Web Awesome otherwise skips the hide transition.
            const selectedMenu = menu;
            void selectedMenu.updateComplete.then(() => {
              selectedMenu.open = false;
              selectedMenu
                .querySelector<HTMLElement>('[slot="trigger"]')
                ?.focus({ preventScroll: true });
            });
          }
        }}
        onWa-after-hide={(event) => {
          if (event.target !== event.currentTarget) {
            return;
          }
          const action = pendingAction;
          pendingAction = undefined;
          action?.();
        }}
      >
        <button
          slot="trigger"
          class="btn btn--ghost chat-pane__layout-trigger"
          type="button"
          aria-label={t("chat.sessionHeader.layout")}
        >
          <span aria-hidden="true">
            <Icon name="columns2" />
          </span>
          {t("chat.sessionHeader.layout")}
        </button>
        <For each={model().actions} keyed={(action) => action.id}>
          {(action) => <LayoutActionItem action={action()} />}
        </For>
        <Show when={model().panelActions.length > 0}>
          <div class="session-menu__separator" role="separator" />
          <For each={model().panelActions} keyed={(action) => action.id}>
            {(action) => <LayoutActionItem action={action()} />}
          </For>
        </Show>
        <LitContent value={model().mainHeaderAction} />
        <LitContent value={model().sideHeaderAction} />
      </wa-dropdown>
    </Show>
  );
}
