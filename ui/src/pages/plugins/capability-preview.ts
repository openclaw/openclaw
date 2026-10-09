import { html, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { withPromiseModalHost } from "../../components/promise-modal-host.ts";
import { t } from "../../i18n/index.ts";

export function showPluginCapabilityPreview(
  name: string,
  content: TemplateResult,
  signal: AbortSignal,
): Promise<void> {
  return withPromiseModalHost({ signal, value: undefined }, ({ render, finish }) => {
    render(
      () => html`<openclaw-modal-dialog
        class="plugin-capability-dialog"
        label=${name}
        @modal-cancel=${() => finish(undefined)}
      >
        <article class="plugin-capability-preview">
          <header>
            <h2>${name}</h2>
            <button
              class="btn btn--icon"
              type="button"
              aria-label=${t("common.close")}
              @click=${() => finish(undefined)}
            >
              ${icons.x}
            </button>
          </header>
          <div class="plugin-capability-preview__body">${content}</div>
        </article>
      </openclaw-modal-dialog>`,
    );
  });
}
