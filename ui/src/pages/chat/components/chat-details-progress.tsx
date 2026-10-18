import { Show } from "solid-js";
import { SessionProgressCard } from "../../../components/session-progress-card-solid.tsx";
import type { MenuHandle } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatDetailsProps } from "./chat-details-types.ts";

type Props = {
  props?: ChatDetailsProps;
  presented: boolean;
  menuRef?: (menu: MenuHandle) => void;
  onHideProgress?: () => void;
};

/** The pane owns the durable card, lifetime and all actions. */
export function ChatDetailsProgress(props: Props) {
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
          onClearSaved={props.props?.onClearSavedProgressCard}
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
          menuRef={props.menuRef}
          menuOptions={{
            class: "chat-details-progress__menu",
            disabled: !props.presented,
            items: [
              { id: "hide", label: t("chat.sessionDetails.hideProgress") },
              {
                id: "collapse",
                label: t("chat.sessionDetails.collapseDefault"),
                type: "checkbox",
                checked: props.props?.collapseTaskProgress === true,
              },
              { id: "settings", label: t("chat.sessionDetails.settings") },
            ],
            onSelect: (item) => {
              switch (item.id) {
                case "hide":
                  props.onHideProgress?.();
                  props.props?.onHideTaskProgress?.();
                  break;
                case "collapse":
                  props.props?.onCollapseTaskProgressChange?.(!props.props?.collapseTaskProgress);
                  break;
                case "settings":
                  props.props?.onOpenTaskProgressSettings?.();
                  break;
              }
            },
          }}
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
