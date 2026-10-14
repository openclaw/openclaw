import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { PanelRefreshStatus as RefreshStatus } from "../panel-refresh-status-state.ts";

export function PanelRefreshStatus(props: {
  status: RefreshStatus;
  errorMessage?: string;
  className?: string;
}) {
  const error = () => {
    const rawError = props.errorMessage ?? props.status.error;
    return rawError ? formatUiError(rawError) : rawError;
  };
  return (
    <>
      {!props.status.awaitingGateway && (error() || props.status.stale) ? (
        <div
          class={["callout", error() ? "danger" : "warn", props.className]}
          role={error() ? "alert" : "status"}
        >
          {error() ? <span>{error()}</span> : undefined}
          {error() && props.status.stale ? <br /> : undefined}
          {props.status.stale ? <strong>{t("common.staleData")}</strong> : undefined}
        </div>
      ) : undefined}
    </>
  );
}
