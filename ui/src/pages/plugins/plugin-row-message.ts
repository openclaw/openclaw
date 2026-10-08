import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import type { PluginInstallRequest } from "../../lib/plugins/index.ts";
import type { PluginInstallPolicyWarningDetails } from "./install-policy-warning.ts";

export type PluginRowMessage = {
  kind: "error" | "warning";
  text: string;
  savedInstall?: string;
  installPolicyWarning?: {
    details: PluginInstallPolicyWarningDetails;
    request: PluginInstallRequest;
  };
};

export function pluginRowKey(pluginId: string): string {
  return `plugin:${pluginId}`;
}

export function renderPluginRowMessage(
  message: PluginRowMessage | undefined,
  options: { busy?: boolean; onContinue?: (request: PluginInstallRequest) => void } = {},
) {
  if (!message) {
    return nothing;
  }
  return html`<div
    class="plugins-row-message plugins-row-message--${message.kind} oc-banner ${
      message.kind === "error" ? "oc-banner-error" : "oc-banner-warning"
    }"
    role=${message.kind === "error" || message.installPolicyWarning ? "alert" : "status"}
  >
    <div>
      ${message.text}
      ${
        message.installPolicyWarning
          ? html`
              <p>${t("pluginConsent.installPolicy.policyScope")}</p>
              ${message.installPolicyWarning.details.findings?.map(
                (finding) => html`<div class="plugins-policy-review__finding">
                  <strong>${t(`pluginConsent.installPolicy.severity.${finding.severity}`)}</strong>
                  <p>${formatUiExternalText(finding.message)}</p>
                  <details>
                    <summary>${t("pluginConsent.installPolicy.technicalDetails")}</summary>
                    <code>${finding.ruleId}</code>
                    ${finding.file ? html`<code>${finding.file}${finding.line ? `:${finding.line}` : ""}</code>` : nothing}
                    ${finding.evidence ? html`<p>${formatUiExternalText(finding.evidence)}</p>` : nothing}
                  </details>
                </div>`,
              )}
              ${
                options.onContinue
                  ? html`<button
                      class="btn btn--sm oc-action oc-action-secondary"
                      type="button"
                      ?disabled=${options.busy}
                      @click=${() => {
                        if (!options.busy) {
                          options.onContinue?.({
                            ...message.installPolicyWarning!.request,
                            acknowledgeInstallPolicyWarning: true,
                          });
                        }
                      }}
                    >
                      ${t("pluginsPage.continueInstall")}
                    </button>`
                  : nothing
              }
            `
          : nothing
      }
    </div>
  </div>`;
}
