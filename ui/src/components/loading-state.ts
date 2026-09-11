import { html } from "lit";
import { t } from "../i18n/index.ts";

export function renderLoadingState() {
  return html`
    <section
      class="lazy-view-state lazy-view-state--loading"
      role="status"
      aria-live="polite"
      aria-label=${t("common.loading")}
    >
      <div class="skeleton skeleton-line skeleton-line--medium" aria-hidden="true"></div>
    </section>
  `;
}
