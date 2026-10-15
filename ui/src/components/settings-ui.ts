// Remaining Lit settings helpers for the chat context-window control and picker fixture.
import { html, nothing, type TemplateResult } from "lit";
import type { SettingsSegmentedProps } from "./settings-controls.ts";

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

export function renderSettingsSegmented<T extends string>(
  props: SettingsSegmentedProps<T, unknown> & { mode: "buttons" },
): TemplateResult<1> {
  return html`<div
    class="settings-segmented ${props.variant ? `settings-segmented--${props.variant}` : ""} ${props.class ?? ""}"
    role=${props.ariaLabel ? "group" : nothing}
    aria-label=${props.ariaLabel ?? nothing}
  >
    ${props.options.map(
      (option) =>
        html`<button
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
