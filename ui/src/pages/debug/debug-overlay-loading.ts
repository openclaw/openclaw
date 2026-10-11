import { html } from "lit";
import { t } from "../../i18n/index.ts";

export const DEBUG_OVERLAY_SECTION_HEADERS = {
  lanes: { id: "lanes", titleKey: "debug.overlay.lanes" },
  status: { id: "status", titleKey: "debug.overlay.status" },
  "active-runs": { id: "active-runs", titleKey: "debug.overlay.activeRuns" },
  events: { id: "events", titleKey: "debug.overlay.events" },
} as const;

export type DebugOverlaySectionId = keyof typeof DEBUG_OVERLAY_SECTION_HEADERS;

export function renderDebugOverlaySectionLoading(id: DebugOverlaySectionId) {
  return html`
    <div
      class="debug-overlay__placeholder debug-overlay__placeholder--${id}"
      role="status"
      aria-label=${t("common.loading")}
    >
      <div class="debug-overlay__placeholder-content" aria-hidden="true">
        ${
          id === "status"
            ? html`<div class="debug-overlay__placeholder-vitals">
                ${["cpu", "memory", "delayP99"].map(
                  (metric) => html`<div class="debug-overlay__placeholder-vital">
                    <span>${t(`debug.overlay.${metric}`)}</span>
                    <div class="skeleton debug-overlay__placeholder-value"></div>
                    <div class="skeleton debug-overlay__placeholder-line"></div>
                  </div>`,
                )}
              </div>`
            : id === "lanes"
              ? html`<div class="debug-overlay__placeholder-lanes">
                  ${["lane", "active", "queued", "blocked"].map(
                    (column) => html`<span>${t(`debug.lanes.${column}`)}</span>`,
                  )}
                  ${Array.from(
                    { length: 12 },
                    () => html`<div class="skeleton debug-overlay__placeholder-line"></div>`,
                  )}
                </div>`
              : html`<div class="debug-overlay__placeholder-rows">
                  ${Array.from(
                    { length: id === "events" ? 3 : 2 },
                    () => html`<div class="skeleton debug-overlay__placeholder-line"></div>`,
                  )}
                </div>`
        }
      </div>
    </div>
  `;
}

export function renderDebugOverlayLoading() {
  return html`${Object.values(DEBUG_OVERLAY_SECTION_HEADERS).map(
    (section) => html`<section class="debug-overlay__section" aria-busy="true">
      <h3>${t(section.titleKey)}</h3>
      ${renderDebugOverlaySectionLoading(section.id)}
    </section>`,
  )}`;
}
