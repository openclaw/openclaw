import { html } from "lit";
import { t } from "../../i18n/index.ts";
import { showPluginCapabilityPreview } from "./capability-preview.ts";

export type PluginToolPreview = {
  name: string;
  description?: string;
  parameters?: Array<{ name: string; required: boolean; type?: string; description?: string }>;
};

export function showPluginToolPreview(tool: PluginToolPreview, signal: AbortSignal): Promise<void> {
  if (!tool.description?.trim() && !tool.parameters?.length) {
    return Promise.resolve();
  }
  return showPluginCapabilityPreview(
    tool.name,
    html`
      ${
        tool.parameters?.length
          ? html`<section class="plugin-tool-preview__parameters">
              <h3>${t("pluginsPage.detailToolInputs")}</h3>
              <dl>
                ${tool.parameters.map(
                  (parameter) => html`<div>
                    <dt>
                      <code>${parameter.name}</code>
                      <span
                        >${t(parameter.required ? "pluginsPage.detailRequired" : "pluginsPage.detailOptional")}</span
                      >
                      ${parameter.type ? html`<span>${parameter.type}</span>` : ""}
                    </dt>
                    ${parameter.description ? html`<dd>${parameter.description}</dd>` : ""}
                  </div>`,
                )}
              </dl>
            </section>`
          : ""
      }
      ${tool.description?.trim() ? html`<p>${tool.description}</p>` : ""}
    `,
    signal,
  );
}
