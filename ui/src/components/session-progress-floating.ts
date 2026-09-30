import { html, nothing, type TemplateResult } from "lit";
import { ref, type Ref } from "lit/directives/ref.js";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";

export type FloatingProgressDisclosure = {
  expanded: boolean;
  bodyId: string;
  element: Ref<HTMLElement>;
  onToggle: () => void;
  onHide: () => void;
  onKeydown: (event: KeyboardEvent) => void;
};

export function renderFloatingProgress(params: {
  disclosure: FloatingProgressDisclosure;
  countLabel: string;
  count: string | undefined;
  activity: unknown;
  controls: TemplateResult;
  refreshStatus: TemplateResult | typeof nothing;
  body: TemplateResult;
}) {
  const { disclosure } = params;
  const label = t("sessionProgressCard.composerTitle");
  return html`<section
    class="session-progress-card session-progress-card--floating"
    data-progress-card-placement="floating"
    data-expanded=${String(disclosure.expanded)}
    aria-label=${t("sessionProgressCard.composerTitle")}
    ${ref(disclosure.element)}
    @keydown=${disclosure.onKeydown}
  >
    <div class="session-progress-card__floating-heading">
      <button
        class="session-progress-card__toggle"
        type="button"
        aria-label=${label}
        aria-expanded=${String(disclosure.expanded)}
        aria-controls=${disclosure.bodyId}
        @click=${disclosure.onToggle}
      >
        <span class="session-progress-card__floating-title"
          >${t("sessionProgressCard.composerTitle")}</span
        >
        ${params.count ? html`<span class="session-progress-card__floating-count" aria-label=${params.countLabel}>${params.count}</span>` : nothing}
        <span class="session-progress-card__chevron" aria-hidden="true">${icons.chevronDown}</span>
      </button>
      <span class="session-progress-card__summary-controls">${params.controls}</span>
    </div>
    <div class="session-progress-card__floating-activity">${params.activity}</div>
    ${params.refreshStatus}
    <div
      class="session-progress-card__reveal"
      id=${disclosure.bodyId}
      ?inert=${!disclosure.expanded}
      aria-hidden=${String(!disclosure.expanded)}
    >
      <div class="session-progress-card__clip">
        <div
          class="session-progress-card__body"
          role="region"
          aria-label=${params.countLabel}
          tabindex="0"
        >
          ${params.body}
        </div>
      </div>
    </div>
  </section>`;
}
