import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import { registerPluginManagementEnglish } from "../../i18n/locales/en-plugin-management.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerPluginManagementEnglish);

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
): JSX.Element {
  const tone = securityTone(status);
  const bars = { pass: 3, warning: 2, danger: 1, unknown: 0 }[tone];
  return (
    <a
      class={`plugin-catalog-detail__security plugin-catalog-detail__security--${tone}`}
      href={auditUrl ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
    >
      <h2>
        {t("pluginsPage.detailSecurity")}
        <span title={t("pluginsPage.detailSecurityAudit")}>{<Icon name="info" />}</span>
      </h2>
      <div class="plugin-catalog-detail__security-score">
        <strong>{tone === "pass" ? "Clean" : tone === "warning" ? "Review" : status}</strong>
        <For each={[0, 1, 2]}>
          {(index) => <span class={index < bars ? "is-filled" : ""} aria-hidden="true" />}
        </For>
      </div>
    </a>
  );
}
