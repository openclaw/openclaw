import { html, type TemplateResult } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";

export interface SelectOption {
  value: string;
  label: string | TemplateResult;
  disabled?: boolean;
}

export function renderSelect(params: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  testId?: string;
  title?: string;
}): TemplateResult {
  return html`
    <select
      class="oc-select"
      .value=${params.value}
      ?disabled=${params.disabled}
      id=${ifDefined(params.id)}
      data-test-id=${ifDefined(params.testId)}
      title=${ifDefined(params.title)}
      @change=${(e: Event) => params.onChange((e.target as HTMLSelectElement).value)}
    >
      ${params.options.map(
        (opt) => html`<option value=${opt.value} ?disabled=${opt.disabled}>${opt.label}</option>`,
      )}
    </select>
  `;
}

export function renderMultiSelect(params: {
  options: SelectOption[];
  selected: Set<string>;
  onChange: (values: string[]) => void;
  disabled?: boolean;
  size?: number;
}): TemplateResult {
  return html`
    <select
      class="oc-select"
      multiple
      size=${params.size ?? 4}
      ?disabled=${params.disabled}
      @change=${(e: Event) =>
        params.onChange(
          Array.from((e.target as HTMLSelectElement).selectedOptions).map((o) => o.value),
        )}
    >
      ${params.options.map(
        (opt) =>
          html`<option value=${opt.value} ?selected=${params.selected.has(opt.value)}>
            ${opt.label}
          </option>`,
      )}
    </select>
  `;
}
