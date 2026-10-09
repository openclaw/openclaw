import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import type { PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
import { showPluginCapabilityPreview } from "./capability-preview.ts";

export type PluginMcpPreview = NonNullable<
  PluginDiscoveryDetailResult["detail"]["mcpServerDetails"]
>[number];

export function showPluginMcpPreview(server: PluginMcpPreview, signal: AbortSignal): Promise<void> {
  const fields = [
    [
      t("pluginsPage.mcpDetails.endpoint"),
      server.endpointRedacted ? t("pluginsPage.mcpDetails.endpointRedacted") : server.url,
    ],
    [t("pluginsPage.mcpDetails.transport"), server.transport],
    [
      t("pluginsPage.mcpDetails.authentication"),
      server.auth ? t(`pluginsPage.mcpDetails.auth.${server.auth}`) : undefined,
    ],
    [t("pluginsPage.mcpDetails.scope"), server.scope],
  ].filter(([, value]) => value);
  return showPluginCapabilityPreview(
    server.name,
    html`
      ${
        fields.length
          ? html`<dl class="plugin-mcp-details">
              ${fields.map(
                ([label, value]) =>
                  html`<dt>${label}</dt>
                    <dd>${value}</dd>`,
              )}
            </dl>`
          : nothing
      }
      ${server.setup ? html`<p>${server.setup}</p>` : nothing}
      ${!fields.length && !server.setup ? html`<p>${t("pluginsPage.mcpDetails.unavailable")}</p>` : nothing}
    `,
    signal,
  );
}
