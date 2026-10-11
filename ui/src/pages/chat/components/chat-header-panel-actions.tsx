import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { nativeListener } from "../../../lib/solid-native-listener.ts";
import {
  LitContent,
  solidContent,
  type LegacyTemplateResult,
} from "../../../lit/solid-content.tsx";
import type { ChatPageHost } from "../chat-state-host.ts";
import {
  ensureSidebarConversation,
  promoteSidebarPanel,
  setSidebarDock,
  setSidebarExpanded,
  sidebarActivePanel,
  sidebarDock,
  sidebarMainPanel,
  type SidebarLayout,
} from "../sidebar-layout.ts";
import type { SidebarPanelDefinition } from "./chat-sidebar-region-types.ts";

export function ChatPanePanelToggle(props: {
  label: string;
  icon: JSX.Element;
  class?: string;
  expanded?: boolean;
  pressed?: boolean;
  onToggle: () => void;
}) {
  return (
    <openclaw-tooltip prop:content={props.label}>
      <button
        class={["btn btn--ghost btn--icon chat-icon-btn ", props.class ?? ""]}
        type="button"
        aria-label={props.label}
        aria-expanded={props.expanded === undefined ? undefined : props.expanded ? "true" : "false"}
        aria-pressed={props.pressed === undefined ? undefined : props.pressed ? "true" : "false"}
        ref={nativeListener("click", () => props.onToggle())}
      >
        {props.icon}
      </button>
    </openclaw-tooltip>
  );
}

export function ChatPanePanelLayoutActions(props: {
  layout: SidebarLayout | undefined;
  definitions: SidebarPanelDefinition[];
  narrow: boolean;
  onLayoutChange: ChatPageHost["updateSidebarLayout"];
}) {
  return (
    <Show when={props.layout}>
      {(layout) => {
        const side = () => sidebarActivePanel(layout());
        const mainDefinition = () =>
          props.definitions.find(
            (definition) =>
              definition.slot === (sidebarMainPanel(layout())?.slot ?? "conversation"),
          );
        const sideDefinition = () =>
          props.definitions.find((definition) => definition.slot === side()?.slot);
        const split = () => layout().open === true && !layout().expanded;
        const swapLabel = () => {
          const main = mainDefinition();
          const active = sideDefinition();
          return main && active
            ? t("chat.sidePanel.swap", { main: main.label, side: active.label })
            : "";
        };
        return (
          <>
            <Show when={mainDefinition()?.headerAction}>
              {(action) => (
                <span class="side-panel__action-group side-panel__action-group--content">
                  <LitContent value={action()} />
                </span>
              )}
            </Show>
            <Show when={split() || layout().expanded}>
              <ChatPanePanelToggle
                label={t(layout().expanded ? "chat.sidePanel.restore" : "chat.sidePanel.expand")}
                icon={<Icon name={layout().expanded ? "minimize" : "maximize"} />}
                class="chat-panel-focus"
                pressed={layout().expanded === true}
                onToggle={() =>
                  props.onLayoutChange(
                    setSidebarExpanded(
                      ensureSidebarConversation(layout()),
                      layout().expanded !== true,
                    ),
                    { dashboardPresentation: "personal" },
                  )
                }
              />
            </Show>
            <Show when={split() && side()}>
              {(active) => (
                <Show when={swapLabel()}>
                  <ChatPanePanelToggle
                    label={swapLabel()}
                    icon={<Icon name="arrowLeftRight" />}
                    class="chat-panel-swap"
                    onToggle={() =>
                      props.onLayoutChange(promoteSidebarPanel(layout(), active().id))
                    }
                  />
                </Show>
              )}
            </Show>
            <Show when={!props.narrow && split()}>
              <wa-dropdown
                class="chat-panel-layout-menu"
                placement="bottom-end"
                onWa-select={(event) => {
                  const dock = event.detail.item.value;
                  if (dock === "left" || dock === "right" || dock === "bottom") {
                    props.onLayoutChange(setSidebarDock(layout(), dock), { geometryOnly: true });
                  }
                }}
              >
                <button
                  slot="trigger"
                  class="btn btn--ghost btn--icon chat-icon-btn"
                  type="button"
                  aria-label={t("chat.sidePanel.layout")}
                  title={t("chat.sidePanel.layout")}
                >
                  <Icon name="columns2" />
                </button>
                <For
                  each={
                    [
                      ["left", "dockLeft", "panelLeftOpen"],
                      ["right", "dockRight", "panelRightOpen"],
                      ["bottom", "dockBottom", "panelBottomOpen"],
                    ] as const
                  }
                >
                  {(option) => (
                    <wa-dropdown-item
                      value={option[0]}
                      type="checkbox"
                      prop:checked={sidebarDock(layout()) === option[0]}
                    >
                      <span slot="icon">
                        <Icon name={option[2]} />
                      </span>
                      {t(`chat.sidePanel.${option[1]}`)}
                    </wa-dropdown-item>
                  )}
                </For>
              </wa-dropdown>
            </Show>
          </>
        );
      }}
    </Show>
  );
}
function LegacyPanelToggle(
  props: Omit<Parameters<typeof ChatPanePanelToggle>[0], "icon" | "class"> & {
    icon: LegacyTemplateResult;
    className?: string;
  },
) {
  return (
    <ChatPanePanelToggle
      label={props.label}
      class={props.className}
      expanded={props.expanded}
      pressed={props.pressed}
      onToggle={props.onToggle}
      icon={<LitContent value={props.icon} />}
    />
  );
}
export const renderChatPanePanelToggle = (props: Parameters<typeof LegacyPanelToggle>[0]) =>
  solidContent(LegacyPanelToggle, props);
export function renderChatPanePanelLayoutActions(
  layout: SidebarLayout | undefined,
  definitions: SidebarPanelDefinition[],
  narrow: boolean,
  onLayoutChange: ChatPageHost["updateSidebarLayout"],
) {
  return solidContent(ChatPanePanelLayoutActions, { layout, definitions, narrow, onLayoutChange });
}
