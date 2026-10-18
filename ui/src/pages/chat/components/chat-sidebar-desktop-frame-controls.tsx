import { Show, createMemo, createUniqueId } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import {
  Menu,
  type MenuEntry,
  type MenuHandle,
  type MenuItem,
} from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  sidebarActivePanel,
  sidebarMainPanel,
  sidebarDock,
  isSidebarNewTabActive,
} from "../sidebar-layout.ts";
import type { RegionProps } from "./chat-sidebar-region-types.ts";

export function DesktopFrameControls(
  props: Pick<RegionProps, "layout" | "panelDefinitions" | "callbacks"> & {
    onCloseAll: () => Promise<void>;
    closing: boolean;
    closable: boolean;
    hasConversation: boolean;
  },
) {
  const id = createUniqueId();
  let menu: MenuHandle | undefined;
  const positions = [
    { dock: "left", labelKey: "chat.sidePanel.positionLeft" },
    { dock: "right", labelKey: "chat.sidePanel.positionRight" },
    { dock: "bottom", labelKey: "chat.sidePanel.positionBelow" },
  ] as const;
  const expanded = () => props.layout.expanded && props.layout.expandedSide;
  const expandLabel = () =>
    expanded()
      ? t("chat.sidePanel.restore")
      : t("chat.sidePanel.expandPanel", { panel: t("chat.sidePanel.label") });
  const swap = createMemo(() => {
    const side = sidebarActivePanel(props.layout);
    const mainSlot = sidebarMainPanel(props.layout)?.slot ?? "conversation";
    if (
      !props.callbacks?.promotePanel ||
      !props.layout.open ||
      props.layout.expanded ||
      isSidebarNewTabActive(props.layout) ||
      !side ||
      !(
        (mainSlot === "conversation" && side.slot === "desktop") ||
        (mainSlot === "desktop" && side.slot === "conversation")
      )
    ) {
      // Dashboard owns its floating action; this menu swaps only Chat and Desktop.
      return undefined;
    }
    const main = props.panelDefinitions.find((definition) => definition.slot === mainSlot);
    const active = props.panelDefinitions.find((definition) => definition.slot === side.slot);
    return main && active
      ? {
          panelId: side.id,
          label: t("chat.sidePanel.swap", { main: main.label, side: active.label }),
        }
      : undefined;
  });
  return (
    <>
      <Menu
        lazy="while-open"
        id={`side-panel-position-${id}`}
        label={t("chat.sidePanel.panelPosition")}
        panelClass="side-panel-position-menu"
        placement="bottom-end"
        triggerClass="rail-header__action side-panel__frame-action"
        triggerAttributes={{ title: t("chat.sidePanel.panelPosition") }}
        trigger={<Icon name="moreHorizontal" />}
        disabled={!props.callbacks}
        ref={(handle) => {
          menu = handle;
        }}
        items={[
          {
            kind: "content",
            id: "position-label",
            content: (
              <div class="side-panel-position-menu__label">{t("chat.sidePanel.panelPosition")}</div>
            ),
          },
          {
            kind: "group",
            id: "position",
            class: "side-panel-position",
            items: positions.map((position): MenuItem => ({
              id: position.dock,
              label: t(position.labelKey),
              type: "radio",
              checked: sidebarDock(props.layout) === position.dock,
              render: (attributes) => (
                <button
                  {...attributes}
                  type="button"
                  class="side-panel-position__option"
                  data-dock={position.dock}
                >
                  <Icon name="sessionPanels" />
                  <span>{t(position.labelKey)}</span>
                </button>
              ),
            })),
          },
          ...(swap()
            ? [{ id: "swap", label: swap()!.label, icon: <Icon name="arrowLeftRight" /> }]
            : []),
          ...(props.closable && props.callbacks?.newTab
            ? ([
                {
                  kind: "content",
                  id: "close-separator",
                  content: <div class="side-panel-position-menu__separator" role="separator" />,
                },
                {
                  id: "close-all",
                  label: props.hasConversation
                    ? t("chat.sidePanel.closeOtherTabs")
                    : t("chat.sidePanel.closeAllTabs"),
                  icon: <Icon name="x" />,
                  disabled: props.closing,
                },
              ] satisfies MenuEntry[])
            : []),
        ]}
        onSelect={(item, event) => {
          if (item.id === "swap") {
            const action = swap();
            if (action) {
              event.preventDefault();
              menu?.close();
              props.callbacks?.promotePanel?.(action.panelId);
            }
            return;
          }
          if (item.id === "close-all") {
            event.preventDefault();
            menu?.close();
            void props.onCloseAll();
            return;
          }
          const position = positions.find((entry) => entry.dock === item.id);
          if (position) {
            // Return focus through the native menu before its frame moves.
            event.preventDefault();
            menu?.close();
            props.callbacks?.setDock(position.dock);
          }
        }}
      />
      <button
        type="button"
        class="rail-header__action side-panel__frame-action"
        title={expandLabel()}
        aria-label={expandLabel()}
        disabled={!props.callbacks}
        onClick={() => props.callbacks?.togglePanelExpanded()}
      >
        <Icon name={expanded() ? "sessionPanelRestore" : "sessionPanelExpand"} />
      </button>
      <Show when={sidebarDock(props.layout) === "bottom"}>
        <button
          type="button"
          class="rail-header__action side-panel__frame-action"
          title={t("chat.sidePanel.minimize")}
          aria-label={t("chat.sidePanel.minimize")}
          disabled={!props.callbacks}
          onClick={() => props.callbacks?.setOpen(false)}
        >
          <Icon name="x" />
        </button>
      </Show>
    </>
  );
}
