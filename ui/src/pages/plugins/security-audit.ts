import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";

function securityLabel(status: string): string {
  return /^(?:clean|pass|safe)$/iu.test(status) ? "Pass" : status;
}

function securityTone(status: string): "pass" | "warning" | "danger" | "unknown" {
  if (/^(?:clean|pass|safe)$/iu.test(status)) {
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
  return html`<a
    class="plugin-catalog-detail__security plugin-catalog-detail__security--${securityTone(status)}"
    href=${auditUrl ?? nothing}
    target="_blank"
    rel="noopener noreferrer"
  >
    <h2>${t("pluginsPage.detailSecurity")} ${icons.info}</h2>
    <div class="plugin-catalog-detail__security-score">
      <strong>${securityLabel(status)}</strong>
      <span aria-hidden="true"></span><span aria-hidden="true"></span
      ><span aria-hidden="true"></span>
    </div>
  </a>`;
}
