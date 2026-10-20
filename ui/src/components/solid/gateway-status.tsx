import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { redactLoginFailureError } from "../../lib/connection-hints.ts";
import type { GatewayStatus as GatewayStatusKind } from "../../lib/gateway-status.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { canRetryGatewayStatus, type GatewayStatusProps } from "../gateway-status.ts";
import { Icon } from "./icon.tsx";
import "../tooltip.ts";

export function gatewayStatusLabel(kind: GatewayStatusKind | "connected", queuedCount = 0): string {
  const status = kind === "connected" ? t("nav.gateway.connected") : t(`connection.${kind}`);
  return queuedCount
    ? `${status} · ${t("connection.queued", { count: String(queuedCount) })}`
    : status;
}

export function GatewayStatus(params: GatewayStatusProps & { row?: boolean }): JSX.Element {
  let retry: HTMLButtonElement | undefined;
  const canRetry = () => params.onRetry && canRetryGatewayStatus(params.kind);
  const label = () => (params.kind ? gatewayStatusLabel(params.kind, params.queuedCount) : "");
  const content = () => (
    <span class="gateway-status__state">
      <span class="gateway-status__icon" aria-hidden="true">
        <Icon
          name={
            params.kind === "connected"
              ? "check"
              : params.kind === "suspending" || params.kind === "suspended"
                ? "pause"
                : params.kind === "offline"
                  ? "alertTriangle"
                  : "refresh"
          }
        />
      </span>
      <span class="gateway-status__label">{label()}</span>
    </span>
  );
  return (
    <Show when={params.kind}>
      <openclaw-tooltip
        class="gateway-status-tooltip"
        prop:content={params.lastError ? redactLoginFailureError(params.lastError) : ""}
        prop:descriptionTarget={canRetry() ? () => retry ?? null : undefined}
      >
        <span
          class={[
            "gateway-status",
            `gateway-status--${params.kind}`,
            { "gateway-status--row": params.row },
          ]}
          role={params.announce ? "status" : undefined}
          aria-live={params.announce ? "polite" : undefined}
          tabindex={params.lastError && !canRetry() ? 0 : undefined}
        >
          <Show when={params.row}>{content()}</Show>
          {canRetry() ? (
            <button
              ref={(element) => (retry = element)}
              type="button"
              class="gateway-status__retry"
              aria-label={`${label()} — ${t("connection.retryNow")}`}
              aria-busy={params.retryPending ? "true" : "false"}
              disabled={params.retryPending}
              onClick={() => {
                if (!params.retryPending) {
                  params.onRetry?.();
                }
              }}
            >
              <Show when={params.retryPending}>
                <span class="gateway-status__spinner" aria-hidden="true">
                  <Icon name="refresh" />
                </span>
              </Show>
              {params.row ? t("common.retry") : content()}
            </button>
          ) : (
            <Show when={!params.row}>{content()}</Show>
          )}
        </span>
      </openclaw-tooltip>
    </Show>
  );
}
