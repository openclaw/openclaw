import type { JSX } from "@solidjs/web";
import { redactLoginFailureError } from "../../lib/connection-hints.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { canRetryGatewayStatus, type GatewayStatusProps } from "../gateway-status.ts";
import { Icon } from "./icon.tsx";
import "../tooltip.ts";

export function renderGatewayStatus(params: GatewayStatusProps): JSX.Element {
  const kind = params.kind;
  if (!kind) {
    return null;
  }
  const label = t(`connection.${kind}`);
  const content = () => (
    <span class="gateway-status__state">
      <span class="gateway-status__icon" aria-hidden="true">
        <Icon
          name={
            kind === "suspending" || kind === "suspended"
              ? "pause"
              : kind === "offline"
                ? "alertTriangle"
                : "refresh"
          }
        />
      </span>
      <span class="gateway-status__label">{label}</span>
    </span>
  );
  const className = `gateway-status gateway-status--${kind}`;
  return (
    <openclaw-tooltip
      class="gateway-status-tooltip"
      prop:content={
        params.lastError && canRetryGatewayStatus(kind)
          ? redactLoginFailureError(params.lastError)
          : ""
      }
    >
      <span
        role={params.announce === false ? undefined : "status"}
        aria-live={params.announce === false ? undefined : "polite"}
      >
        {params.onRetry && canRetryGatewayStatus(kind) ? (
          <button
            type="button"
            class={className}
            aria-label={[label, t("connection.retryNow")].filter(Boolean).join(" — ")}
            onClick={params.onRetry}
          >
            {content()}
          </button>
        ) : (
          <span class={className}>{content()}</span>
        )}
      </span>
    </openclaw-tooltip>
  );
}
