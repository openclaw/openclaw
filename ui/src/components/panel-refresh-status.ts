import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { PanelRefreshStatus } from "./panel-refresh-status-state.ts";

export {
  beginPanelRefresh,
  completePanelRefresh,
  createPanelRefreshStatus,
  failPanelRefresh,
  type PanelRefreshStatus,
} from "./panel-refresh-status-state.ts";

export function renderPanelRefreshStatus(params: {
  status: PanelRefreshStatus;
  errorMessage?: string;
  className?: string;
}): TemplateResult | typeof nothing {
  const { status } = params;
  if (status.awaitingGateway) {
    return nothing;
  }
  const rawError = params.errorMessage ?? status.error;
  const error = rawError ? formatUiError(rawError) : rawError;
  if (!error && !status.stale) {
    return nothing;
  }
  const className = params.className ? ` ${params.className}` : "";
  return html`
    <div
      class="callout ${error ? "danger" : "warn"}${className}"
      role=${error ? "alert" : "status"}
    >
      ${error ? html`<span>${error}</span>` : nothing}
      ${error && status.stale ? html`<br />` : nothing}
      ${status.stale ? html`<strong>${t("common.staleData")}</strong>` : nothing}
    </div>
  `;
}
