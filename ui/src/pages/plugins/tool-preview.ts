import { html } from "lit";
import { icons } from "../../components/icons.ts";
import { withPromiseModalHost } from "../../components/promise-modal-host.ts";
import { t } from "../../i18n/index.ts";

export type PluginToolPreview = {
  name: string;
  description?: string;
  parameters?: Array<{ name: string; required: boolean; type?: string; description?: string }>;
};

export function showPluginToolPreview(tool: PluginToolPreview, signal: AbortSignal): Promise<void> {
  if (!tool.description?.trim() && !tool.parameters?.length) {
    return Promise.resolve();
  }
  return withPromiseModalHost({ signal, value: undefined }, ({ render, finish }) => {
    render(
      () => html`<openclaw-modal-dialog
        class="plugin-tool-dialog"
        label=${tool.name}
        @modal-cancel=${() => finish(undefined)}
      >
        <article class="plugin-tool-preview">
          <header>
            <h2>${tool.name}</h2>
            <button
              class="btn btn--icon"
              type="button"
              aria-label=${t("common.close")}
              @click=${() => finish(undefined)}
            >
              ${icons.x}
            </button>
          </header>
          <div class="plugin-tool-preview__body">
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
                              >${t(
                                parameter.required
                                  ? "pluginsPage.detailRequired"
                                  : "pluginsPage.detailOptional",
                              )}</span
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
          </div>
        </article>
      </openclaw-modal-dialog>`,
    );
  });
}
