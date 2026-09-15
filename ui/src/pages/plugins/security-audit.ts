import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";

registerPluginManagementEnglish();

function securityLabel(status: string): string {
  if (/^(?:clean|pass|safe|benign|cleared)$/iu.test(status)) {
    return "Clean";
  }
  if (/^(?:suspicious|warning|review)$/iu.test(status)) {
    return "Review";
  }
  return status;
}

function securityTone(status: string): "pass" | "warning" | "danger" | "unknown" {
  if (/^(?:clean|pass|safe|benign|cleared)$/iu.test(status)) {
    return "pass";
  }
  if (/^(?:suspicious|warning|review)$/iu.test(status)) {
    return "warning";
  }
  if (/^(?:blocked|danger|fail|malicious)$/iu.test(status)) {
    return "danger";
  }
  return "unknown";
}

export function renderPluginSecurityAudit(
  status: string,
  auditUrl: string | null | undefined,
): TemplateResult {
  const tone = securityTone(status);
  const bars = { pass: 3, warning: 2, danger: 1, unknown: 0 }[tone];
  return html`<a
    class="plugin-catalog-detail__security plugin-catalog-detail__security--${tone}"
    href=${auditUrl ?? nothing}
    target="_blank"
    rel="noopener noreferrer"
  >
    <h2>
      ${t("pluginsPage.detailSecurity")}
      <span title=${t("pluginsPage.detailSecurityAudit")}>${icons.info}</span>
    </h2>
    <div class="plugin-catalog-detail__security-score">
      <strong>${securityLabel(status)}</strong>
      ${[0, 1, 2].map((index) => html`<span class=${index < bars ? "is-filled" : ""} aria-hidden="true"></span>`)}
    </div>
  </a>`;
}
