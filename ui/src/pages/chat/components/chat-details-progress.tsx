import { Show, onCleanup } from "solid-js";
import { renderSessionProgressCard } from "../../../components/session-progress-card.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/web-awesome.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  defineSolidBridge,
  LitContent,
  type SolidBridgeElement,
} from "../../../lit/solid-bridge.ts";
import type { ChatDetailsProps } from "./chat-details-types.ts";

type Props = { props?: ChatDetailsProps; presented: boolean };
export type ChatDetailsProgress = SolidBridgeElement<Props>;

/** The pane owns the durable card, lifetime and all actions. */
export const ChatDetailsProgress = defineSolidBridge<Props>(
  "openclaw-chat-details-progress",
  (props) => {
    let menu!: HTMLElement;
    const stopSummaryToggle = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    <wa-dropdown
      ref={(element) => {
        menu = element;
        // Lit inserts this menu into a summary outside Solid's delegated event tree.
        menu.addEventListener("click", stopSummaryToggle);
      }}
      class="chat-details-progress__menu"
      placement="bottom-end"
      onWa-select={(event: CustomEvent<{ item: { value?: string } }>) => {
        if (!props.presented) {
          return;
        }
        const current = props.props;
        switch (event.detail.item.value) {
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
          default:
            break;
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="session-progress-card__refresh"
        aria-label={t("chat.sessionDetails.progressOptions")}
      >
        <Icon name="moreHorizontal" />
      </button>
      <wa-dropdown-item value="hide">{t("chat.sessionDetails.hideProgress")}</wa-dropdown-item>
      <wa-dropdown-item
        value="collapse"
        type="checkbox"
        prop:checked={props.props?.collapseTaskProgress === true}
      >
        {t("chat.sessionDetails.collapseDefault")}
      </wa-dropdown-item>
      <wa-dropdown-item value="settings">{t("chat.sessionDetails.settings")}</wa-dropdown-item>
      {props.props?.onClearSavedProgressCard && (
        <wa-dropdown-item value="clear">{t("sessionProgressCard.clearSaved")}</wa-dropdown-item>
      )}
    </wa-dropdown>;
    onCleanup(() => menu.removeEventListener("click", stopSummaryToggle));
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
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-details-progress": ChatDetailsProgress;
  }
}
