import { html, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { icons } from "../../../components/icons.ts";
import { renderSessionProgressCard } from "../../../components/session-progress-card.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import type { ChatDetailsProps } from "./chat-details-types.ts";

/** Presentation only: the pane owns the durable card, lifetime and all actions. */
export class ChatDetailsProgress extends OpenClawLightDomElement {
  @property({ attribute: false }) props?: ChatDetailsProps;
  @property({ type: Boolean }) presented = false;

  private menu(props: ChatDetailsProps): TemplateResult {
    return html`<wa-dropdown
      class="chat-details-progress__menu"
      placement="bottom-end"
      @click=${(event: MouseEvent) => {
        // Custom menu items are not native interactive descendants of summary.
        event.preventDefault();
        event.stopPropagation();
      }}
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        if (!this.presented || this.props !== props) {
          return;
        }
        switch (event.detail.item.value) {
          case "hide":
            props.onHideTaskProgress?.();
            break;
          case "collapse":
            props.onCollapseTaskProgressChange?.(!props.collapseTaskProgress);
            break;
          case "settings":
            props.onOpenTaskProgressSettings?.();
            break;
          case "clear":
            if (props.progressCard) {
              props.onClearSavedProgressCard?.(props.progressCard);
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
        aria-label=${t("chat.sessionDetails.progressOptions")}
      >
        ${icons.moreHorizontal}
      </button>
      <wa-dropdown-item value="hide"> ${t("chat.sessionDetails.hideProgress")} </wa-dropdown-item>
      <wa-dropdown-item
        value="collapse"
        type="checkbox"
        .checked=${props.collapseTaskProgress === true}
      >
        ${t("chat.sessionDetails.collapseDefault")}
      </wa-dropdown-item>
      <wa-dropdown-item value="settings"> ${t("chat.sessionDetails.settings")} </wa-dropdown-item>
      ${props.onClearSavedProgressCard ? html`<wa-dropdown-item value="clear">${t("sessionProgressCard.clearSaved")}</wa-dropdown-item>` : nothing}
    </wa-dropdown>`;
  }

  override render() {
    const props = this.props;
    if (!props?.progressCard) {
      return props?.progressCardInitialLoading
        ? html`<div class="chat-details__muted" role="status">
            ${t("sessionProgressCard.widgetLoading")}
          </div>`
        : nothing;
    }
    const session = props.selectedSession;
    return renderSessionProgressCard(
      props.progressCard,
      "details",
      props.onDismissProgressCard,
      session?.status,
      session?.startedAt,
      session?.endedAt,
      props.runActive,
      props.collapseTaskProgress,
      {
        presented: this.presented,
        gatewayScope: props.gatewayScope,
        sessionIdentity: props.progressCardIdentity,
        cardLifetime: props.progressCardLifetime,
        manualOnly: true,
      },
      props.progressCardRefresh,
      undefined,
      this.menu(props),
    );
  }
}

customElements.define("openclaw-chat-details-progress", ChatDetailsProgress);
