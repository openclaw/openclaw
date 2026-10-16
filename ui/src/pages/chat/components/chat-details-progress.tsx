import { Show, createEffect } from "solid-js";
import { SessionProgressCard } from "../../../components/session-progress-card-solid.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu, type MenuEntry, type MenuHandle } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatDetailsProps } from "./chat-details-types.ts";

type Props = {
  props?: ChatDetailsProps;
  presented: boolean;
  menuRef?: (menu: MenuHandle) => void;
  onHideProgress?: () => void;
};
let nextMenuId = 0;

/** The pane owns the durable card, lifetime and all actions. */
export function ChatDetailsProgress(props: Props) {
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
            props.onHideProgress?.();
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
  return (
    <openclaw-chat-details-progress>
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
        <SessionProgressCard
          card={props.props?.progressCard}
          placement="details"
          onDismiss={props.props?.onDismissProgressCard}
          sessionStatus={props.props?.selectedSession?.status}
          startedAt={props.props?.selectedSession?.startedAt}
          endedAt={props.props?.selectedSession?.endedAt}
          hasActiveRun={props.props?.runActive}
          collapseComposerByDefault={props.props?.collapseTaskProgress}
          composerDisclosureContext={{
            presented: props.presented,
            gatewayScope: props.props?.gatewayScope,
            sessionIdentity: props.props?.progressCardIdentity,
            cardLifetime: props.props?.progressCardLifetime,
            manualOnly: true,
          }}
          refreshAction={props.props?.progressCardRefresh}
          headingMenu={menu}
        />
      </Show>
    </openclaw-chat-details-progress>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-details-progress": HTMLAttributes<HTMLElement>;
    }
  }
}
