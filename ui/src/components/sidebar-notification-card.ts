import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";
import "./relative-time.ts";

export function renderSidebarDismissButton(
  itemLabel: string,
  onDismiss?: () => void,
  dismissing?: boolean,
) {
  if (!onDismiss) {
    return nothing;
  }
  const label = t("attention.dismissItem", { item: itemLabel });
  return html`<button
    type="button"
    class="sidebar-issues-panel__dismiss"
    aria-label=${label}
    aria-busy=${dismissing ? "true" : nothing}
    title=${dismissing ? t("attention.mentions.dismissing") : label}
    ?disabled=${dismissing}
    @click=${(event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
    }}
  >
    ${icons.x}
  </button>`;
}

export function renderSidebarNotificationCard(props: {
  title: string;
  detail: string;
  timestampMs?: number | null;
  icon: TemplateResult;
  severity?: "error" | "warning";
  critical?: boolean;
  dismissing?: boolean;
  onDismiss?: () => void;
  body: TemplateResult | typeof nothing;
  bodyClass?: string;
}) {
  return html`<details
    class="sidebar-issues-panel__details ${props.severity ? `sidebar-issues-panel__details--${props.severity}` : ""}"
  >
    <summary class="sidebar-issues-panel__summary" data-issue-row-focus>
      <span
        class="sidebar-issues-panel__icon ${props.critical ? "sidebar-issues-panel__icon--critical" : ""}"
        aria-hidden="true"
        >${props.icon}</span
      >
      <span class="sidebar-issues-panel__content">
        <span class="sidebar-issues-panel__entity" title=${props.title}>${props.title}</span>
        <span class="sidebar-issues-panel__state-row sidebar-issues-panel__notification-meta">
          <span class="sidebar-issues-panel__state" title=${props.detail}>${props.detail}</span>
          ${
            props.timestampMs == null
              ? nothing
              : html`
                  <span aria-hidden="true">·</span>
                  <openclaw-relative-time
                    class="sidebar-issues-panel__age"
                    .timestampMs=${props.timestampMs}
                  ></openclaw-relative-time>
                `
          }
        </span>
      </span>
      ${renderSidebarDismissButton(props.title, props.onDismiss, props.dismissing)}
      <span class="sidebar-issues-panel__chevron" aria-hidden="true">${icons.chevronRight}</span>
    </summary>
    <div class="sidebar-issues-panel__body ${props.bodyClass ?? ""}">${props.body}</div>
  </details>`;
}
