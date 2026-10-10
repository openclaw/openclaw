import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { PanelRefreshStatus } from "../panel-refresh-status.ts";

export function renderPanelRefreshStatus(props: {
  status: PanelRefreshStatus;
  errorMessage?: string;
  className?: string;
}): JSX.Element {
  const error = () => {
    const message = props.errorMessage ?? props.status.error;
    return message ? formatUiError(message) : message;
  };
  return (
    <Show when={!props.status.awaitingGateway && (error() || props.status.stale)}>
      <div
        class={["callout", props.className, { danger: Boolean(error()), warn: !error() }]}
        role={error() ? "alert" : "status"}
      >
        <Show when={error()}>
          <span>{error()}</span>
        </Show>
        <Show when={error() && props.status.stale}>
          <br />
        </Show>
        <Show when={props.status.stale}>
          <strong>{t("common.staleData")}</strong>
        </Show>
      </div>
    </Show>
  );
}
