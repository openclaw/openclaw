import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { live } from "lit/directives/live.js";
import type { McpAppSettings } from "../../../src/shared/mcp-app-extensions.js";
import { t } from "../i18n/index.ts";
import { registerMcpAppEnglish } from "../i18n/locales/en-mcp-app.ts";

registerMcpAppEnglish();

export type McpAppSettingsView = {
  settings: McpAppSettings;
  values: McpAppSettings["values"];
  busy: boolean;
  onChange: (key: string, value: string | number | boolean) => void;
  onSave: () => void;
  onTool: (name: string) => void;
};

export function renderMcpAppSettings(view: McpAppSettingsView) {
  const { settings, values } = view;
  const hasChanges = () =>
    Object.entries(values).some(([key, value]) => settings.values[key] !== value);
  const field = (key: string) => {
    const schema = settings.schema.properties[key];
    if (!schema) {
      return nothing;
    }
    const required = settings.schema.required?.includes(key) ?? false;
    const value = values[key];
    return html`<label class="mcp-app-settings__field"
      ><span>${schema.title}</span
      >${schema.description ? html`<small class="muted">${schema.description}</small>` : nothing}
      ${
        schema.type === "boolean"
          ? html`<input
              type="checkbox"
              .checked=${live(value === true)}
              ?disabled=${view.busy}
              @change=${(event: Event) => {
                if (event.currentTarget instanceof HTMLInputElement) {
                  view.onChange(key, event.currentTarget.checked);
                }
              }}
            />`
          : schema.type === "string" && schema.enum
            ? html`<select
                .value=${live(String(value ?? ""))}
                ?required=${required}
                ?disabled=${view.busy}
                @change=${(event: Event) => {
                  if (event.currentTarget instanceof HTMLSelectElement) {
                    view.onChange(key, event.currentTarget.value);
                  }
                }}
              >
                ${schema.enum.map((option) => html`<option .value=${option} .selected=${option === value}>${option}</option>`)}
              </select>`
            : keyed(
                schema.type === "string",
                html`<input
                  type=${schema.type === "string" ? "text" : "number"}
                  .value=${live(String(value ?? ""))}
                  ?required=${required}
                  ?disabled=${view.busy}
                  minlength=${schema.type === "string" ? (schema.minLength ?? nothing) : nothing}
                  maxlength=${schema.type === "string" ? (schema.maxLength ?? nothing) : nothing}
                  pattern=${schema.type === "string" ? (schema.pattern ?? nothing) : nothing}
                  min=${schema.type !== "string" ? (schema.minimum ?? nothing) : nothing}
                  max=${schema.type !== "string" ? (schema.maximum ?? nothing) : nothing}
                  step=${schema.type === "string" ? nothing : (schema.multipleOf ?? (schema.type === "integer" ? 1 : "any"))}
                  @input=${(event: Event) => {
                    const input = event.currentTarget;
                    if (input instanceof HTMLInputElement) {
                      if (schema.type === "string") {
                        view.onChange(key, input.value);
                      } else if (Number.isFinite(input.valueAsNumber)) {
                        view.onChange(key, input.valueAsNumber);
                      }
                    }
                  }}
                />`,
              )
      }
    </label>`;
  };
  const rendered = new Set(
    settings.layout?.flatMap((group) =>
      group.items.flatMap((item) => (item.kind === "property" ? [item.property] : [])),
    ),
  );
  return html`<form
    class="mcp-app-settings"
    @submit=${(event: SubmitEvent) => {
      event.preventDefault();
      if (
        hasChanges() &&
        event.currentTarget instanceof HTMLFormElement &&
        event.currentTarget.reportValidity()
      ) {
        view.onSave();
      }
    }}
  >
    <p class="muted">${t("mcpApp.settingsDescription")}</p>
    ${settings.layout?.map(
      (group) =>
        html`<fieldset ?disabled=${view.busy}>
          <legend>${group.title}</legend>
          ${group.items.map((item) => (item.kind === "property" ? field(item.property) : html`<div class="mcp-app-settings__field"><button type="button" class="btn" @click=${() => view.onTool(item.tool)}>${item.title}</button>${item.description ? html`<small>${item.description}</small>` : nothing}</div>`))}
        </fieldset>`,
    )}
    ${Object.keys(settings.schema.properties)
      .filter((key) => !rendered.has(key))
      .map(field)}
    <button type="submit" class="btn primary" ?disabled=${view.busy || !hasChanges()}>
      ${t("mcpApp.save")}
    </button>
  </form>`;
}
