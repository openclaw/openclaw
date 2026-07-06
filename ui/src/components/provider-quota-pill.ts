import { html, nothing } from "lit";
import type { ModelAuthStatusResult } from "../api/types.ts";
import { normalizeBasePath } from "../app-route-paths.ts";
import { t } from "../i18n/index.ts";
import { isMonitoredAuthProvider } from "../lib/model-auth.ts";
import {
  collectQuotaWindowsFromAuthStatus,
  formatQuotaReset,
} from "../lib/provider-quota-summary.ts";

export type ProviderQuotaPillProps = {
  basePath?: string;
  modelAuthStatusResult?: ModelAuthStatusResult | null;
};

export function renderProviderQuotaPill(props: ProviderQuotaPillProps) {
  const windows = collectQuotaWindowsFromAuthStatus(
    props.modelAuthStatusResult ?? null,
    isMonitoredAuthProvider,
  );
  const primary = windows[0];
  if (!primary) {
    return nothing;
  }
  const secondary = windows.find(
    (entry) => entry.displayName !== primary.displayName || entry.label !== primary.label,
  );
  const reset = formatQuotaReset(primary.resetAt);
  const detail = [primary.displayName, primary.label, reset ? `resets ${reset}` : null]
    .filter(Boolean)
    .join(" · ");
  const secondaryDetail = secondary
    ? `${secondary.displayName}${secondary.label ? ` ${secondary.label}` : ""} ${secondary.remaining}% left`
    : null;
  const title = [detail, secondaryDetail].filter(Boolean).join(" · ");
  const severity = primary.remaining <= 10 ? "danger" : primary.remaining <= 25 ? "warn" : "ok";
  const href = `${normalizeBasePath(props.basePath ?? "")}/usage`;

  return html`
    <a
      class="chat-controls__quota chat-controls__quota--${severity}"
      href=${href}
      title=${title}
      aria-label=${`Provider usage: ${title}`}
      data-chat-provider-usage="true"
    >
      <span class="chat-controls__quota-label">${t("chat.usageRemaining")}</span>
      <span class="chat-controls__quota-value">${primary.remaining}%</span>
    </a>
  `;
}
