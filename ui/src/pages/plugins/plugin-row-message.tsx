import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import { formatUiExternalText } from "../../lib/format-error.ts";
import type { PluginInstallRequest } from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
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
): JSX.Element {
  if (!message) {
    return undefined;
  }
  return (
    <div
      class={[
        "plugins-row-message",
        `plugins-row-message--${message.kind}`,
        "oc-banner",
        {
          "oc-banner-error": message.kind === "error",
          "oc-banner-warning": message.kind !== "error",
        },
      ]}
      role={message.kind === "error" || message.installPolicyWarning ? "alert" : "status"}
    >
      <div>
        {message.text}
        {message.installPolicyWarning ? (
          <>
            <p>{t("pluginConsent.installPolicy.policyScope")}</p>
            {
              <For each={message.installPolicyWarning.details.findings}>
                {(finding) => (
                  <div class="plugins-policy-review__finding">
                    <strong>{t(`pluginConsent.installPolicy.severity.${finding.severity}`)}</strong>
                    <p>{formatUiExternalText(finding.message)}</p>
                    <details>
                      <summary>{t("pluginConsent.installPolicy.technicalDetails")}</summary>
                      <code>{finding.ruleId}</code>
                      {finding.file ? (
                        <code>
                          {finding.file}
                          {finding.line ? `:${finding.line}` : ""}
                        </code>
                      ) : undefined}
                      {finding.evidence ? (
                        <p>{formatUiExternalText(finding.evidence)}</p>
                      ) : undefined}
                    </details>
                  </div>
                )}
              </For>
            }
            {options.onContinue ? (
              <button
                class="btn btn--sm oc-action oc-action-secondary"
                type="button"
                disabled={options.busy}
                onClick={() => {
                  if (!options.busy) {
                    options.onContinue?.({
                      ...message.installPolicyWarning!.request,
                      acknowledgeInstallPolicyWarning: true,
                    });
                  }
                }}
              >
                {t("pluginsPage.continueInstall")}
              </button>
            ) : undefined}
          </>
        ) : undefined}
      </div>
    </div>
  );
}
