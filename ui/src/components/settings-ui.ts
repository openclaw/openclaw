// Settings design-language primitives. Every settings surface builds its
// layout through these helpers so pages cannot drift back into bespoke
// card/pill markup. Styles live in ui/src/styles/settings.css and the shared
// ui/src/styles/settings-controls.css; rules in ui/docs/design-system/settings-design.md.
import { html, nothing, type TemplateResult } from "lit";
import { Directive, directive } from "lit/directive.js";
import { live } from "lit/directives/live.js";
import { shellLayoutTraits } from "../app/shell-layout-traits.ts";
import { t } from "../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { icons } from "./icons.ts";
import {
  nextSettingsRadioName,
  settingsRadioChange,
  settingsRadioClick,
  settingsRadioKeyDown,
  settingsSwitchChange,
  settingsSwitchClick,
  settingsSwitchKeyDown,
  settingsToggleRowClick,
  type SettingsSegmentedProps,
  type SettingsToggleControl,
} from "./settings-controls.ts";
import "./tooltip.ts";

type SettingsStatusKind = "ok" | "warn" | "danger" | "accent" | "muted";

const CARAPACE_STATUS_CLASS: Record<SettingsStatusKind, string> = {
  accent: "oc-status-info",
  danger: "oc-status-error",
  muted: "",
  ok: "oc-status-success",
  warn: "oc-status-warning",
};

type SettingsRowControl = TemplateResult | typeof nothing;

type SettingsRowProps = {
  title: unknown;
  description?: unknown;
  control?: SettingsRowControl;
  /** Opts this row into the shared Carapace settings contract. */
  carapace?: boolean;
  /** Full-width control below the text (textareas, segmented sets that wrap). */
  stacked?: boolean;
  /** Full-width control below the text through the narrow-layout breakpoint. */
  stackedOnNarrow?: boolean;
};

export type SettingsSectionProps = {
  title?: unknown;
  description?: unknown;
  /** Right-aligned inline actions next to the heading (e.g. an Add button). */
  actions?: TemplateResult;
  /** Section notice above the group, keeping bordered callouts outside the card. */
  notice?: TemplateResult | typeof nothing;
  count?: number;
  danger?: boolean;
  /** Opts this section into the shared Carapace settings contract. */
  carapace?: boolean;
};

type SettingsHelpTriggerProps = {
  id: string;
  label: string;
  tooltip: string;
  icon: "question" | "info";
  popoverId: string;
};

export type SettingsPageHeaderProps = {
  title: unknown;
  subtitle?: unknown;
  actions?: TemplateResult | typeof nothing;
};

export function renderSettingsPage(
  children: unknown,
  options: { wide?: boolean; carapace?: boolean } = {},
): TemplateResult {
  const className = [
    "settings-page",
    options.wide ? "settings-page--wide" : "",
    options.carapace ? "oc-app-surface" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`<div
    class=${className}
    ${shellLayoutTraits({ settingsPage: true, settingsWide: options.wide })}
  >
    ${children}
  </div>`;
}

export function renderSettingsHelpTrigger(props: SettingsHelpTriggerProps): TemplateResult {
  const helpIcon = props.icon === "info" ? icons.info : icons.circleQuestionMark;
  return html`
    <openclaw-tooltip .content=${props.tooltip}>
      <button
        id=${props.id}
        type="button"
        class="settings-section__help-button"
        aria-label=${props.label}
        aria-controls=${props.popoverId}
        aria-haspopup="dialog"
      >
        <span aria-hidden="true">${helpIcon}</span>
      </button>
    </openclaw-tooltip>
  `;
}

export function renderLearnMoreLink(url: string): TemplateResult {
  return html`<a
    class="learn-more-link"
    href=${url}
    target=${EXTERNAL_LINK_TARGET}
    rel=${buildExternalLinkRel()}
    >${t("common.learnMore")}</a
  >`;
}

export function renderSettingsPageHeader(props: SettingsPageHeaderProps): TemplateResult {
  return html`
    <section
      class="content-header content-header--settings"
      ${shellLayoutTraits({ toolbarHeader: true })}
    >
      <div>
        <h1 class="page-title">${props.title}</h1>
        ${props.subtitle ? html`<div class="page-subtitle">${props.subtitle}</div>` : nothing}
      </div>
      ${
        props.actions && props.actions !== nothing
          ? html`<div class="page-header-actions">${props.actions}</div>`
          : nothing
      }
    </section>
  `;
}

export function renderSettingsSection(props: SettingsSectionProps, rows: unknown): TemplateResult {
  const description = props.description
    ? html`<p class="settings-section__desc">${props.description}</p>`
    : nothing;
  const copy =
    props.title || props.description
      ? html`
          <div
            class="settings-section__copy ${props.carapace ? "oc-settings-section-heading" : ""}"
          >
            ${
              props.title
                ? html`
                    <h2
                      class="settings-section__heading ${
                        props.carapace ? "oc-settings-section-title" : ""
                      }"
                    >
                      ${props.title}${
                        props.count !== undefined
                          ? html` <span class="settings-count">${props.count}</span>`
                          : nothing
                      }
                    </h2>
                  `
                : nothing
            }
            ${description}
          </div>
        `
      : nothing;
  const header =
    copy || props.actions
      ? html`
          <div
            class="settings-section__header ${props.carapace ? "oc-settings-section-header" : ""}"
          >
            ${copy}
            ${
              props.actions
                ? html`<div class="settings-section__actions">${props.actions}</div>`
                : nothing
            }
          </div>
        `
      : nothing;
  return html`
    <section class="settings-section ${props.carapace ? "oc-settings-section" : ""}">
      ${header} ${props.notice ?? nothing} ${renderSettingsGroup(rows, props)}
    </section>
  `;
}

export function renderSettingsSummary(items: ReadonlyArray<{ label: string; value: number }>) {
  return html`<dl class="settings-summary">
    ${items.map(
      (item) => html`<div class="settings-group settings-summary__tile">
        <dt>${item.label}</dt>
        <dd>${item.value}</dd>
      </div>`,
    )}
  </dl>`;
}

/** A bare group surface without a section heading (rare; prefer sections). */
export function renderSettingsGroup(
  rows: unknown,
  options: { danger?: boolean; carapace?: boolean } = {},
) {
  const groupClass = [
    "settings-group",
    options.danger ? "settings-group--danger" : "",
    options.carapace ? "oc-settings-group" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`<div class=${groupClass}>${rows}</div>`;
}

function renderSettingsRowText(title: unknown, description: unknown, carapace = false) {
  return html`
    <div class="settings-row__text ${carapace ? "oc-settings-row-content" : ""}">
      <span class="settings-row__title ${carapace ? "oc-settings-row-title" : ""}">${title}</span>
      ${
        description
          ? html`<span class="settings-row__desc ${carapace ? "oc-settings-row-description" : ""}"
              >${description}</span
            >`
          : nothing
      }
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
    props.carapace ? `oc-settings-row${props.stacked ? " oc-settings-row-stacked" : ""}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <div class=${className} role=${props.role ?? nothing}>
      ${renderSettingsRowText(props.title, props.description, props.carapace)}
      ${
        props.control !== undefined && props.control !== nothing
          ? html`<div
              class="settings-row__control ${props.carapace ? "oc-settings-row-control" : ""}"
            >
              ${props.control}
            </div>`
          : nothing
      }
    </div>
  `;
}

export function renderSettingsNavRow(
  props: Omit<SettingsRowProps, "stacked" | "stackedOnNarrow"> & { onClick: () => void },
): TemplateResult {
  return html`
    <button type="button" class="settings-row settings-row--nav" @click=${props.onClick}>
      ${renderSettingsRowText(props.title, props.description)}
      <div class="settings-row__control">
        ${props.control ?? nothing}
        <span class="settings-row__chevron">${icons.chevronRight}</span>
      </div>
    </button>
  `;
}

function renderToggleControl(props: SettingsToggleControl, label: unknown) {
  const labelId = nextSettingsRadioName();
  return html`<span class="settings-toggle">
    <input
      class="settings-toggle__input"
      type="checkbox"
      role="switch"
      .checked=${live(props.checked)}
      ?disabled=${props.disabled ?? false}
      aria-labelledby=${labelId}
      @click=${(event: MouseEvent) => settingsSwitchClick(event, props)}
      @keydown=${(event: KeyboardEvent) => settingsSwitchKeyDown(event, props)}
      @change=${(event: Event) => settingsSwitchChange(event, props)}
    />
    <span class="settings-toggle__control" aria-hidden="true"></span>
    <span id=${labelId} class="settings-control__sr-label">${label}</span>
  </span>`;
}

/** Toggle for a custom control slot; the row title is not an input label. */
export function renderSettingsToggle(
  props: SettingsToggleControl & { ariaLabel: string },
): TemplateResult {
  return renderToggleControl(props, props.ariaLabel);
}

/** The whole row activates the switch, whose accessible name follows the title. */
export function renderSettingsToggleRow(
  props: SettingsToggleControl & {
    icon?: unknown;
    title: unknown;
    ariaLabel?: unknown;
    description?: unknown;
  },
): TemplateResult {
  return html`
    <div
      class="settings-row settings-row--toggle"
      @click=${(event: MouseEvent) => settingsToggleRowClick(event, props)}
    >
      ${props.icon ?? nothing} ${renderSettingsRowText(props.title, props.description)}
      <div class="settings-row__control">
        ${renderToggleControl(props, props.ariaLabel ?? props.title)}
      </div>
    </div>
  `;
}

// Controls already show inherited values; reserve default references for overrides.
export function renderSettingsDefaultDescription(value: string, overridden: boolean) {
  return overridden ? html`${t("configForm.defaultValue", { value })}` : undefined;
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

export function renderSettingsStatus(props: {
  kind: SettingsStatusKind;
  label: unknown;
  dot?: boolean;
  carapace?: boolean;
}): TemplateResult {
  const modifier = props.kind === "muted" ? "" : ` settings-status--${props.kind}`;
  return html`
    <span
      class="settings-status${modifier}${
        props.carapace ? ` oc-status ${CARAPACE_STATUS_CLASS[props.kind]}` : ""
      }"
    >
      ${
        props.dot === false
          ? nothing
          : html`<span
              class="settings-status__dot ${props.carapace ? "oc-status-indicator" : ""}"
            ></span>`
      }
      <span class=${props.carapace ? "oc-status-label" : ""}>${props.label}</span>
    </span>
  `;
}

export function renderSettingsValue(value: unknown, options: { mono?: boolean } = {}) {
  const className = options.mono
    ? "settings-row__value settings-row__value--mono"
    : "settings-row__value";
  return html`<span class=${className}>${value}</span>`;
}

export function renderSettingsEmpty(
  message: unknown,
  options: { carapace?: boolean } = {},
): TemplateResult {
  return options.carapace
    ? html`<div class="settings-empty oc-empty">
        <div class="oc-empty-content"><p class="oc-empty-description">${message}</p></div>
      </div>`
    : html`<div class="settings-empty">${message}</div>`;
}

export function renderSettingsLoadingSkeleton(
  options: { label?: unknown; rows?: number; carapace?: boolean } = {},
): TemplateResult {
  const rowCount = Math.max(1, options.rows ?? 3);
  return html`
    <div
      class="settings-loading-skeleton"
      role="status"
      aria-busy="true"
      aria-label=${options.label ?? t("common.loading")}
    >
      <div class="settings-loading-skeleton__rows" aria-hidden="true">
        ${Array.from(
          { length: rowCount },
          (_, index) => html`
            <div
              class="settings-row settings-loading-skeleton__row ${
                options.carapace ? "oc-settings-row" : ""
              }"
            >
              <div class="settings-row__text ${options.carapace ? "oc-settings-row-content" : ""}">
                <span
                  class="skeleton settings-loading-skeleton__title ${
                    options.carapace ? "oc-skeleton-line oc-skeleton-line-short" : ""
                  }"
                ></span>
                <span
                  class="skeleton settings-loading-skeleton__description ${
                    options.carapace ? "oc-skeleton-line" : ""
                  }"
                ></span>
              </div>
              <div class="settings-row__control">
                <span
                  class="skeleton settings-loading-skeleton__control ${
                    index % 2 === 0 ? "settings-loading-skeleton__control--wide" : ""
                  }"
                ></span>
              </div>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}
