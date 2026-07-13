// Settings design-language primitives. Every settings surface builds its
// layout through these helpers so pages cannot drift back into bespoke
// card/pill markup. Styles live in ui/src/styles/settings.css; rules in
// ui/docs/settings-design.md.
import { html, nothing, type TemplateResult } from "lit";
import { icons } from "./icons.ts";

type SettingsStatusKind = "ok" | "warn" | "danger" | "accent" | "muted";

export type SettingsRowControl = TemplateResult | typeof nothing;

export type SettingsRowProps = {
  title: unknown;
  description?: unknown;
  control?: SettingsRowControl;
  /** Full-width control below the text (textareas, segmented sets that wrap). */
  stacked?: boolean;
};

export type SettingsSectionProps = {
  title?: unknown;
  description?: unknown;
  /** Right-aligned inline actions next to the heading (e.g. an Add button). */
  actions?: TemplateResult;
  /** Extra count shown next to the heading. */
  count?: number;
  /** Marks the group surface as a danger zone. */
  danger?: boolean;
};

export function renderSettingsPage(
  children: unknown,
  options: { wide?: boolean; intro?: unknown } = {},
): TemplateResult {
  const className = options.wide ? "settings-page settings-page--wide" : "settings-page";
  return html`
    <div class=${className}>
      ${options.intro ? html`<p class="settings-page__intro">${options.intro}</p>` : nothing}
      ${children}
    </div>
  `;
}

/** Section = plain text heading + one group surface containing rows. */
export function renderSettingsSection(props: SettingsSectionProps, rows: unknown): TemplateResult {
  const heading =
    props.title || props.actions
      ? html`
          <div class="settings-section__header">
            <h2 class="settings-section__heading">
              ${props.title}${props.count !== undefined
                ? html` <span class="settings-count">${props.count}</span>`
                : nothing}
            </h2>
            ${props.actions
              ? html`<div class="settings-section__actions">${props.actions}</div>`
              : nothing}
          </div>
        `
      : nothing;
  const description = props.description
    ? html`<p class="settings-section__desc">${props.description}</p>`
    : nothing;
  const groupClass = props.danger ? "settings-group settings-group--danger" : "settings-group";
  return html`
    <section class="settings-section">
      ${heading}${description}
      <div class=${groupClass}>${rows}</div>
    </section>
  `;
}

/** A bare group surface without a section heading (rare; prefer sections). */
export function renderSettingsGroup(rows: unknown, options: { danger?: boolean } = {}) {
  const groupClass = options.danger ? "settings-group settings-group--danger" : "settings-group";
  return html`<div class=${groupClass}>${rows}</div>`;
}

export function renderSettingsRow(props: SettingsRowProps): TemplateResult {
  const className = props.stacked ? "settings-row settings-row--stacked" : "settings-row";
  return html`
    <div class=${className}>
      <div class="settings-row__text">
        <span class="settings-row__title">${props.title}</span>
        ${props.description
          ? html`<span class="settings-row__desc">${props.description}</span>`
          : nothing}
      </div>
      ${props.control !== undefined && props.control !== nothing
        ? html`<div class="settings-row__control">${props.control}</div>`
        : nothing}
    </div>
  `;
}

/** Clickable drill-in row with a trailing chevron. */
export function renderSettingsNavRow(
  props: Omit<SettingsRowProps, "stacked"> & { onClick: () => void },
): TemplateResult {
  return html`
    <button type="button" class="settings-row settings-row--nav" @click=${props.onClick}>
      <div class="settings-row__text">
        <span class="settings-row__title">${props.title}</span>
        ${props.description
          ? html`<span class="settings-row__desc">${props.description}</span>`
          : nothing}
      </div>
      <div class="settings-row__control">
        ${props.control ?? nothing}
        <span class="settings-row__chevron">${icons.chevronRight}</span>
      </div>
    </button>
  `;
}

export function renderSettingsToggle(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}): TemplateResult {
  return html`
    <label class="settings-toggle">
      <input
        type="checkbox"
        .checked=${props.checked}
        ?disabled=${props.disabled ?? false}
        aria-label=${props.ariaLabel ?? nothing}
        @change=${(event: Event) => {
          props.onChange((event.target as HTMLInputElement).checked);
        }}
      />
      <span class="settings-toggle__track"></span>
    </label>
  `;
}

export function renderSettingsSegmented<T extends string>(props: {
  value: T;
  options: ReadonlyArray<{ value: T; label: unknown }>;
  onChange: (value: T) => void;
}): TemplateResult {
  return html`
    <div class="settings-segmented" role="group">
      ${props.options.map(
        (option) => html`
          <button
            type="button"
            class="settings-segmented__btn ${option.value === props.value
              ? "settings-segmented__btn--active"
              : ""}"
            aria-pressed=${option.value === props.value ? "true" : "false"}
            @click=${() => props.onChange(option.value)}
          >
            ${option.label}
          </button>
        `,
      )}
    </div>
  `;
}

/** Status = dot + plain text. Replaces status pills across settings. */
export function renderSettingsStatus(props: {
  kind: SettingsStatusKind;
  label: unknown;
}): TemplateResult {
  const modifier = props.kind === "muted" ? "" : ` settings-status--${props.kind}`;
  return html`
    <span class="settings-status${modifier}">
      <span class="settings-status__dot"></span>
      ${props.label}
    </span>
  `;
}

/** Right-aligned plain text value inside a row control. */
export function renderSettingsValue(value: unknown, options: { mono?: boolean } = {}) {
  const className = options.mono
    ? "settings-row__value settings-row__value--mono"
    : "settings-row__value";
  return html`<span class=${className}>${value}</span>`;
}

export function renderSettingsEmpty(message: unknown): TemplateResult {
  return html`<div class="settings-empty">${message}</div>`;
}
