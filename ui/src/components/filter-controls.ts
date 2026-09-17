import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { ifDefined } from "lit/directives/if-defined.js";
import type {
  ControlUiFilterChoicesProps,
  ControlUiFilterSwitchProps,
} from "../../../src/plugin-sdk/control-ui-components.js";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import "../styles/filter-controls.css";

export type FilterChoicesProps<Value extends string = string> = Omit<
  ControlUiFilterChoicesProps,
  "value" | "options" | "onChange"
> & {
  value: Value;
  options: readonly { value: Value; label: string; title?: string; icon?: unknown }[];
  onChange: (value: Value) => void;
};

export type FilterSwitchProps = ControlUiFilterSwitchProps;

export function renderFilterChoices<Value extends string>(props: FilterChoicesProps<Value>) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!props.keyboardNavigation || !(event.currentTarget instanceof HTMLElement)) {
      return;
    }
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
    const current = buttons.findIndex((button) => button === event.target);
    if (current < 0) {
      return;
    }
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (current + 1) % buttons.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (current + buttons.length - 1) % buttons.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = buttons.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    buttons[next]?.focus();
    const option = props.options[next];
    if (option) {
      props.onChange(option.value);
    }
  };
  return html`<div class="filter-choice">
    <span class="filter-section__label">${props.label}</span>
    <div
      class="filter-view-toggle"
      role="group"
      aria-label=${props.label}
      style=${ifDefined(props.columns ? `--filter-columns: ${props.columns}` : undefined)}
      @keydown=${onKeyDown}
    >
      ${props.options.map(
        (option) => html`<button
          class="btn ${props.value === option.value ? "is-active" : ""}"
          type="button"
          aria-pressed=${props.value === option.value}
          aria-label=${option.title ?? option.label}
          title=${option.title ?? option.label}
          tabindex=${ifDefined(props.keyboardNavigation ? (props.value === option.value ? 0 : -1) : undefined)}
          @click=${() => props.onChange(option.value)}
        >
          ${option.icon ? html`<span aria-hidden="true">${option.icon}</span>` : nothing}
          <span>${option.label}</span>
        </button>`,
      )}
    </div>
  </div>`;
}

export function renderFilterSwitch(props: FilterSwitchProps) {
  return html`<label class="filter-row filter-switch">
    <span>${props.label}</span>
    <input
      type="checkbox"
      role="switch"
      .checked=${props.checked}
      @change=${(event: Event) => {
        if (event.currentTarget instanceof HTMLInputElement) {
          props.onChange(event.currentTarget.checked);
        }
      }}
    />
  </label>`;
}

export class FilterChoices extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) props?: FilterChoicesProps;
  protected override render() {
    return this.props ? renderFilterChoices(this.props) : nothing;
  }
}

export class FilterSwitch extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) props?: FilterSwitchProps;
  protected override render() {
    return this.props ? renderFilterSwitch(this.props) : nothing;
  }
}

if (!customElements.get("openclaw-filter-choices")) {
  customElements.define("openclaw-filter-choices", FilterChoices);
}
if (!customElements.get("openclaw-filter-switch")) {
  customElements.define("openclaw-filter-switch", FilterSwitch);
}
