import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import { redactLoginFailureError } from "../lib/connection-hints.ts";
import type { GatewayStatus } from "../lib/gateway-status.ts";
import { icons } from "./icons.ts";

export function canRetryGatewayStatus(kind: GatewayStatus | null): boolean {
  return kind === "reconnecting" || kind === "offline";
}

export type GatewayStatusProps = {
  kind: GatewayStatus | null;
  lastError?: string | null;
  onRetry?: () => void;
  announce?: boolean;
};

export function renderGatewayStatus(props: GatewayStatusProps) {
  const { kind } = props;
  if (!kind) {
    return nothing;
  }
  const label = kind ? t(`connection.${kind}`) : null;
  const content = html`
    ${kind ? html`<span class="gateway-status__state"><span class="gateway-status__icon" aria-hidden="true">${kind === "suspending" || kind === "suspended" ? icons.pause : kind === "offline" ? icons.alertTriangle : icons.refresh}</span><span class="gateway-status__label">${label}</span></span>` : nothing}
  `;
  const className = `gateway-status${kind ? ` gateway-status--${kind}` : ""}`;
  const retry = props.onRetry && canRetryGatewayStatus(kind);
  const status = retry
    ? html`<button
        type="button"
        class=${className}
        aria-label=${[label, t("connection.retryNow")].filter(Boolean).join(" — ")}
        @click=${props.onRetry}
      >
        ${content}
      </button>`
    : html`<span class=${className}>${content}</span>`;
  return html`<openclaw-tooltip
    class="gateway-status-tooltip"
    .content=${
      props.lastError && canRetryGatewayStatus(kind) ? redactLoginFailureError(props.lastError) : ""
    }
    ><span
      role=${props.announce === false ? nothing : "status"}
      aria-live=${props.announce === false ? nothing : "polite"}
      >${status}</span
    ></openclaw-tooltip
  >`;
}
