import { html, nothing } from "lit";
import type { PluginInstallRequest } from "../../lib/plugins/index.ts";
import type { PluginInstallPolicyWarningDetails } from "./install-policy-warning.ts";

export type PluginRowMessage = {
  kind: "success" | "error" | "warning";
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

export function renderPluginRowMessage(message: PluginRowMessage | undefined) {
  if (!message) {
    return nothing;
  }
  return html`<div
    class="plugins-row-message plugins-row-message--${message.kind} oc-banner ${
      message.kind === "error"
        ? "oc-banner-error"
        : message.kind === "warning"
          ? "oc-banner-warning"
          : "oc-banner-success"
    }"
    role=${message.kind === "error" ? "alert" : "status"}
  >
    ${message.text}
  </div>`;
}
