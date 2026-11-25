import type { JSX } from "@solidjs/web";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { PanelRefreshStatus as RefreshStatus } from "../panel-refresh-status-state.ts";
import { InlineAlert } from "./inline-alert.tsx";

export function PanelRefreshStatus(props: {
  status: RefreshStatus;
  errorMessage?: string;
  className?: JSX.ClassValue;
}) {
  const error = () => {
    const rawError = props.errorMessage ?? props.status.error;
    return rawError ? formatUiError(rawError) : rawError;
  };
  return (
    <>
      {!props.status.awaitingGateway && (error() || props.status.stale) ? (
        <InlineAlert tone={error() ? "danger" : "warning"} class={props.className}>
          {error() ? <span>{error()}</span> : undefined}
          {error() && props.status.stale ? <br /> : undefined}
          {props.status.stale ? <strong>{t("common.staleData")}</strong> : undefined}
        </InlineAlert>
      ) : undefined}
    </>
  );
}
