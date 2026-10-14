import { Show, createEffect } from "solid-js";
import { renderSessionProgressCard } from "../../../components/session-progress-card.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu, type MenuEntry, type MenuHandle } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  defineSolidBridge,
  LitContent,
  type SolidBridgeElement,
} from "../../../lit/solid-bridge.ts";
import type { ChatDetailsProps } from "./chat-details-types.ts";

type Props = { props?: ChatDetailsProps; presented: boolean; menuRef?: (menu: MenuHandle) => void };
export type ChatDetailsProgress = SolidBridgeElement<Props>;
let nextMenuId = 0;

/** The pane owns the durable card, lifetime and all actions. */
export const ChatDetailsProgress = defineSolidBridge<Props>(
  "openclaw-chat-details-progress",
  (props) => {
    const menuId = `chat-progress-options-${++nextMenuId}`;
    let handle: MenuHandle | undefined;
    let menu!: HTMLElement;
    const stopSummaryToggle = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const items = (): MenuEntry[] => [
      { id: "hide", label: t("chat.sessionDetails.hideProgress") },
      {
        id: "collapse",
        label: t("chat.sessionDetails.collapseDefault"),
        type: "checkbox",
        checked: props.props?.collapseTaskProgress === true,
      },
      { id: "settings", label: t("chat.sessionDetails.settings") },
      ...(props.props?.onClearSavedProgressCard
        ? [{ id: "clear", label: t("sessionProgressCard.clearSaved") }]
        : []),
    ];
    <div
      ref={(element) => {
        menu = element;
      }}
      onClick={stopSummaryToggle}
    >
      <Menu
        id={menuId}
        class="chat-details-progress__menu"
        triggerClass="session-progress-card__refresh"
        label={t("chat.sessionDetails.progressOptions")}
        placement="bottom-end"
        trigger={<Icon name="moreHorizontal" />}
        items={items()}
        disabled={!props.presented}
        ref={(value) => {
          handle = value;
          props.menuRef?.(value);
        }}
        onSelect={(item) => {
          if (!props.presented) {
            return;
          }
          const current = props.props;
          switch (item.id) {
            case "hide":
              current?.onHideTaskProgress?.();
              break;
            case "collapse":
              current?.onCollapseTaskProgressChange?.(!current.collapseTaskProgress);
              break;
            case "settings":
              current?.onOpenTaskProgressSettings?.();
              break;
            case "clear":
              if (current?.progressCard) {
                current.onClearSavedProgressCard?.(current.progressCard);
              }
              break;
          }
        }}
      />
    </div>;
    createEffect(
      () => props.presented,
      (presented) => {
        if (!presented) {
          handle?.close();
        }
      },
    );
    const card = () => {
      t("chat.sessionDetails.title");
      const current = props.props;
      const session = current?.selectedSession;
      return renderSessionProgressCard(
        current?.progressCard,
        "details",
        current?.onDismissProgressCard,
        session?.status,
        session?.startedAt,
        session?.endedAt,
        current?.runActive,
        current?.collapseTaskProgress,
        {
          presented: props.presented,
          gatewayScope: current?.gatewayScope,
          sessionIdentity: current?.progressCardIdentity,
          cardLifetime: current?.progressCardLifetime,
          manualOnly: true,
        },
        current?.progressCardRefresh,
        undefined,
        menu,
      );
    };
    return (
      <Show
        when={props.props?.progressCard}
        fallback={
          props.props?.progressCardInitialLoading && (
            <div class="chat-details__muted" role="status">
              {t("sessionProgressCard.widgetLoading")}
            </div>
          )
        }
      >
        <LitContent render={() => card()} />
      </Show>
    );
  },
  {
    properties: {
      props: { default: undefined, attribute: false },
      presented: { default: false, type: Boolean },
      menuRef: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-details-progress": ChatDetailsProgress;
  }
}
