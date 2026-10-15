// Remaining Lit settings adapters; Solid primitives live in ./solid/settings-ui.tsx.
import { html, nothing, type TemplateResult } from "lit";
import { Directive, directive } from "lit/directive.js";
import { live } from "lit/directives/live.js";
import {
  nextSettingsRadioName,
  settingsRadioChange,
  settingsRadioClick,
  settingsRadioKeyDown,
  type SettingsSegmentedProps,
} from "./settings-controls.ts";

type SettingsRowControl = TemplateResult | typeof nothing;

type SettingsRowProps = {
  title: unknown;
  description?: unknown;
  control?: SettingsRowControl;
  /** Full-width control below the text (textareas, segmented sets that wrap). */
  stacked?: boolean;
  /** Full-width control below the text through the narrow-layout breakpoint. */
  stackedOnNarrow?: boolean;
};

function renderSettingsRowText(title: unknown, description: unknown) {
  return html`
    <div class="settings-row__text">
      <span class="settings-row__title">${title}</span>
      ${description ? html`<span class="settings-row__desc">${description}</span>` : nothing}
    </div>
  `;
}

export function renderSettingsRow(
  props: SettingsRowProps & { role?: "alert" | "status" },
): TemplateResult {
  const className = [
    "settings-row",
    props.stacked ? "settings-row--stacked" : "",
    props.stackedOnNarrow ? "settings-row--stacked-on-narrow" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <div class=${className} role=${props.role ?? nothing}>
      ${renderSettingsRowText(props.title, props.description)}
      ${
        props.control !== undefined && props.control !== nothing
          ? html`<div class="settings-row__control">${props.control}</div>`
          : nothing
      }
    </div>
  `;
}

class SettingsRadioGroupDirective extends Directive {
  // Renaming a checked radio can uncheck a sibling before Lit updates its value.
  private readonly name = nextSettingsRadioName();

  render(renderGroup: (name: string) => TemplateResult) {
    return renderGroup(this.name);
  }
}

function renderSettingsRadioGroup<T extends string>(
  props: SettingsSegmentedProps<T, unknown>,
  name: string,
) {
  return html`<div
    class="settings-segmented ${props.class ?? ""}"
    role="radiogroup"
    aria-label=${props.ariaLabel ?? nothing}
    aria-describedby=${props.descriptionId ?? nothing}
    aria-orientation="horizontal"
  >
    ${props.options.map(
      (option) => html`
        <label
          class="settings-segmented__btn ${option.value === props.value ? "settings-segmented__btn--active" : ""}"
          title=${option.title ?? nothing}
          data-test-id=${option.testId ?? nothing}
        >
          <input
            class="settings-segmented__input"
            type="radio"
            name=${name}
            value=${option.value}
            .checked=${live(option.value === props.value)}
            ?disabled=${props.disabled || option.disabled}
            aria-label=${option.ariaLabel ?? nothing}
            @click=${(event: MouseEvent) => settingsRadioClick(event, option.value, props)}
            @change=${(event: Event) => settingsRadioChange(event, option.value, props)}
            @keydown=${settingsRadioKeyDown}
          />
          ${option.label}
        </label>
      `,
    )}
  </div>`;
}

const settingsRadioGroup = directive(SettingsRadioGroupDirective);

export function renderSettingsSegmented<T extends string>(
  props: SettingsSegmentedProps<T, unknown>,
): TemplateResult<1> {
  if (props.mode === "buttons") {
    return html`<div
      class="settings-segmented ${props.variant ? `settings-segmented--${props.variant}` : ""} ${props.class ?? ""}"
      role=${props.ariaLabel ? "group" : nothing}
      aria-label=${props.ariaLabel ?? nothing}
    >
      ${props.options.map(
        (option) => html`<button
          type="button"
          class="settings-segmented__btn ${option.value === props.value ? "settings-segmented__btn--active" : ""} ${props.variant === "accent" ? "btn btn--sm" : ""}"
          aria-pressed=${props.ariaPressed === false ? nothing : String(option.value === props.value)}
          aria-label=${option.ariaLabel ?? nothing}
          data-compact-label=${option.compactLabel ?? nothing}
          data-test-id=${option.testId ?? nothing}
          title=${option.title ?? nothing}
          ?disabled=${props.disabled || option.disabled}
          @click=${(event: MouseEvent) => {
            props.onClick?.(event, option.value);
            if (event.defaultPrevented || props.disabled || option.disabled) {
              return;
            }
            if (option.value === props.value) {
              props.onReselect?.(option.value);
            } else {
              props.onChange(option.value);
            }
          }}
        >
          ${option.label}
        </button>`,
      )}
    </div>`;
  }
  return html`${settingsRadioGroup((name) => renderSettingsRadioGroup(props, name))}`;
}
