import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import "../../components/modal-dialog.ts";
import "../../styles/model-setup.css";
registerSettingsEnglish();

/** Shared centered connection form; callers own authoring and selection lifetimes. */
export function renderProviderConnectionDialog(props: {
  title: string;
  description: unknown;
  busy: boolean;
  disabled: boolean;
  key?: { value: string; disabled?: boolean; onChange: (value: string) => void };
  content?: TemplateResult;
  error?: string;
  actionLabel: string;
  onAction: () => void;
  onCancel: () => void;
}) {
  return html`<openclaw-modal-dialog
    label=${props.title}
    @modal-cancel=${(event: Event) => {
      event.preventDefault();
      if (!props.busy) {
        props.onCancel();
      }
    }}
  >
    <div class="model-setup-wizard" data-models-key-dialog>
      <div class="model-setup-wizard__header"><h2>${props.title}</h2></div>
      <div class="model-setup-wizard__body">
        <p>${props.description}</p>
        ${
          props.key
            ? html`<label class="field"
                ><span>${t("modelProviders.apiKey.label")}</span
                ><input
                  type="password"
                  autocomplete="off"
                  autofocus
                  placeholder=${t("modelProviders.apiKey.placeholder")}
                  .value=${props.key.value}
                  ?disabled=${props.key.disabled || props.busy}
                  @input=${(event: Event) => {
                    if (event.currentTarget instanceof HTMLInputElement) {
                      props.key?.onChange(event.currentTarget.value);
                    }
                  }}
              /></label>`
            : nothing
        }
        ${props.content ?? nothing}${props.error ? html`<div class="callout error" role="alert">${props.error}</div>` : nothing}
      </div>
      <div class="model-setup-wizard__footer">
        <button class="btn" ?disabled=${props.busy} @click=${props.onCancel}>
          ${t("common.cancel")}</button
        ><button
          class="btn primary"
          ?disabled=${props.disabled || props.busy}
          @click=${props.onAction}
        >
          ${props.busy ? t("modelProviders.saving") : props.actionLabel}
        </button>
      </div>
    </div>
  </openclaw-modal-dialog>`;
}
