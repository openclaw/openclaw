import type { JSX } from "@solidjs/web";
import { children, For, Show } from "solid-js";
import { ShellLayoutBoundary } from "../../app/shell-layout-traits-solid.tsx";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { t } from "../../lib/reactive/i18n.ts";
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
} from "../settings-controls.ts";
import { Icon } from "./icon.tsx";
import "../tooltip.ts";

type SettingsStatusKind = "ok" | "warn" | "danger" | "accent" | "muted";
const CARAPACE_STATUS_CLASS: Record<SettingsStatusKind, string> = {
  accent: "oc-status-info",
  danger: "oc-status-error",
  muted: "",
  ok: "oc-status-success",
  warn: "oc-status-warning",
};

type SettingsRowProps = {
  title: JSX.Element;
  description?: JSX.Element;
  control?: JSX.Element;
  carapace?: boolean;
  stacked?: boolean;
  stackedOnNarrow?: boolean;
};

export function SettingsPage(props: {
  children?: JSX.Element;
  wide?: boolean;
  carapace?: boolean;
}) {
  return (
    <ShellLayoutBoundary traits={{ settingsPage: true, settingsWide: props.wide }}>
      <div
        class={[
          "settings-page",
          { "settings-page--wide": props.wide, "oc-app-surface": props.carapace },
        ]}
      >
        {props.children}
      </div>
    </ShellLayoutBoundary>
  );
}

export function DocsLink(props: { url: string; children: JSX.Element }) {
  return (
    <a href={props.url} target={EXTERNAL_LINK_TARGET} rel={buildExternalLinkRel()}>
      {props.children}
    </a>
  );
}

export function SettingsHelpTrigger(props: {
  id: string;
  label: string;
  tooltip: string;
  icon: "question" | "info";
  popoverId: string;
}) {
  return (
    <openclaw-tooltip prop:content={props.tooltip}>
      <button
        id={props.id}
        type="button"
        class="settings-section__help-button"
        aria-label={props.label}
        aria-controls={props.popoverId}
        aria-haspopup="dialog"
      >
        <span aria-hidden="true">
          <Icon name={props.icon === "info" ? "info" : "circleQuestionMark"} />
        </span>
      </button>
    </openclaw-tooltip>
  );
}

export function LearnMoreLink(props: { url: string }) {
  return (
    <a
      class="learn-more-link"
      href={props.url}
      target={EXTERNAL_LINK_TARGET}
      rel={buildExternalLinkRel()}
    >
      {t("common.learnMore")}
    </a>
  );
}

export function SettingsPageHeader(props: {
  title: JSX.Element;
  subtitle?: JSX.Element;
  actions?: JSX.Element;
}) {
  return (
    <ShellLayoutBoundary traits={{ toolbarHeader: true }}>
      <section class="content-header content-header--settings">
        <div>
          <h1 class="page-title">{props.title}</h1>
          <Show when={props.subtitle}>
            <div class="page-subtitle">{props.subtitle}</div>
          </Show>
        </div>
        <Show when={props.actions}>
          <div class="page-header-actions">{props.actions}</div>
        </Show>
      </section>
    </ShellLayoutBoundary>
  );
}

export function SettingsSection(props: {
  title?: JSX.Element;
  description?: JSX.Element;
  actions?: JSX.Element;
  notice?: JSX.Element;
  count?: number;
  danger?: boolean;
  carapace?: boolean;
  children?: JSX.Element;
}) {
  return (
    <section class={["settings-section", { "oc-settings-section": props.carapace }]}>
      <Show when={props.title || props.description || props.actions}>
        <div class={["settings-section__header", { "oc-settings-section-header": props.carapace }]}>
          <Show when={props.title || props.description}>
            <div
              class={["settings-section__copy", { "oc-settings-section-heading": props.carapace }]}
            >
              <Show when={props.title}>
                <h2
                  class={[
                    "settings-section__heading",
                    { "oc-settings-section-title": props.carapace },
                  ]}
                >
                  {props.title}
                  <Show when={props.count !== undefined}>
                    {" "}
                    <span class="settings-count">{props.count}</span>
                  </Show>
                </h2>
              </Show>
              <Show when={props.description}>
                <p class="settings-section__desc">{props.description}</p>
              </Show>
            </div>
          </Show>
          <Show when={props.actions}>
            <div class="settings-section__actions">{props.actions}</div>
          </Show>
        </div>
      </Show>
      {props.notice}
      <SettingsGroup danger={props.danger} carapace={props.carapace}>
        {props.children}
      </SettingsGroup>
    </section>
  );
}

export function SettingsSummary(props: { items: ReadonlyArray<{ label: string; value: number }> }) {
  return (
    <dl class="settings-summary">
      <For each={props.items}>
        {(item) => (
          <div class="settings-group settings-summary__tile">
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}

export function SettingsGroup(props: {
  children?: JSX.Element;
  danger?: boolean;
  carapace?: boolean;
}) {
  return (
    <div
      class={[
        "settings-group",
        { "settings-group--danger": props.danger, "oc-settings-group": props.carapace },
      ]}
    >
      {props.children}
    </div>
  );
}

function SettingsRowText(
  props: Pick<SettingsRowProps, "title" | "description" | "carapace"> & { id?: string },
) {
  return (
    <div class={["settings-row__text", { "oc-settings-row-content": props.carapace }]}>
      <span
        id={props.id}
        class={["settings-row__title", { "oc-settings-row-title": props.carapace }]}
      >
        {props.title}
      </span>
      <Show when={props.description}>
        <span class={["settings-row__desc", { "oc-settings-row-description": props.carapace }]}>
          {props.description}
        </span>
      </Show>
    </div>
  );
}

export function SettingsRow(props: SettingsRowProps & { role?: "alert" | "status" }) {
  const control = children(() => props.control);
  return (
    <div
      class={[
        "settings-row",
        {
          "settings-row--stacked": props.stacked,
          "settings-row--stacked-on-narrow": props.stackedOnNarrow,
          "oc-settings-row": props.carapace,
          "oc-settings-row-stacked": props.carapace && props.stacked,
        },
      ]}
      role={props.role}
    >
      <SettingsRowText
        title={props.title}
        description={props.description}
        carapace={props.carapace}
      />
      <Show when={control() !== undefined && control() !== null && control() !== false}>
        <div class={["settings-row__control", { "oc-settings-row-control": props.carapace }]}>
          {control()}
        </div>
      </Show>
    </div>
  );
}

export function SettingsNavRow(
  props: Omit<SettingsRowProps, "stacked" | "stackedOnNarrow"> & { onClick: () => void },
) {
  return (
    <button type="button" class="settings-row settings-row--nav" onClick={() => props.onClick()}>
      <SettingsRowText title={props.title} description={props.description} />
      <div class="settings-row__control">
        {props.control}
        <span class="settings-row__chevron">
          <Icon name="chevronRight" />
        </span>
      </div>
    </button>
  );
}

function ToggleControl(
  props: SettingsToggleControl & { label?: JSX.Element; labelledBy?: string },
) {
  const labelId = nextSettingsRadioName();
  return (
    <span class="settings-toggle">
      <input
        class="settings-toggle__input"
        type="checkbox"
        role="switch"
        checked={props.checked}
        disabled={props.disabled}
        aria-labelledby={props.labelledBy ?? labelId}
        onClick={(event) => settingsSwitchClick(event, props)}
        onChange={(event) => settingsSwitchChange(event, props)}
        onKeyDown={(event) => settingsSwitchKeyDown(event, props)}
      />
      <span class="settings-toggle__control" aria-hidden="true" />
      <Show when={!props.labelledBy}>
        <span id={labelId} class="settings-control__sr-label">
          {props.label}
        </span>
      </Show>
    </span>
  );
}

export function SettingsToggle(props: SettingsToggleControl & { ariaLabel: string }) {
  return (
    <ToggleControl
      checked={props.checked}
      disabled={props.disabled}
      onChange={(checked) => props.onChange(checked)}
      onAct={(checked) => props.onAct?.(checked)}
      label={props.ariaLabel}
    />
  );
}

export function SettingsToggleRow(
  props: SettingsToggleControl & {
    icon?: JSX.Element;
    title: JSX.Element;
    ariaLabel?: JSX.Element;
    description?: JSX.Element;
  },
) {
  const titleId = nextSettingsRadioName();
  return (
    <div
      class="settings-row settings-row--toggle"
      onClick={(event) => settingsToggleRowClick(event, props)}
    >
      {props.icon}
      <SettingsRowText id={titleId} title={props.title} description={props.description} />
      <div class="settings-row__control">
        <ToggleControl
          checked={props.checked}
          disabled={props.disabled}
          onChange={(checked) => props.onChange(checked)}
          onAct={(checked) => props.onAct?.(checked)}
          label={props.ariaLabel}
          labelledBy={props.ariaLabel == null ? titleId : undefined}
        />
      </div>
    </div>
  );
}

export function SettingsDefaultDescription(props: { value: string; overridden: boolean }) {
  return (
    <Show when={props.overridden}>{t("configForm.defaultValue", { value: props.value })}</Show>
  );
}

export function SettingsSegmented<T extends string>(props: SettingsSegmentedProps<T, JSX.Element>) {
  const name = nextSettingsRadioName();
  return (
    <Show
      when={props.mode === "buttons"}
      fallback={
        <div
          class={["settings-segmented", props.class]}
          role="radiogroup"
          aria-label={props.ariaLabel}
          aria-describedby={props.descriptionId}
          aria-orientation="horizontal"
        >
          <For each={props.options} keyed={(option) => option.value}>
            {(option) => (
              <label
                class={[
                  "settings-segmented__btn",
                  { "settings-segmented__btn--active": option().value === props.value },
                ]}
                title={option().title}
                data-test-id={option().testId}
              >
                <input
                  class="settings-segmented__input"
                  type="radio"
                  name={name}
                  value={option().value}
                  checked={option().value === props.value}
                  disabled={props.disabled || option().disabled}
                  aria-label={option().ariaLabel}
                  onClick={(event) => settingsRadioClick(event, option().value, props)}
                  onChange={(event) => settingsRadioChange(event, option().value, props)}
                  onKeyDown={settingsRadioKeyDown}
                />
                {option().label}
              </label>
            )}
          </For>
        </div>
      }
    >
      <SettingsSegmentedButtons {...props} />
    </Show>
  );
}

function SettingsSegmentedButtons<T extends string>(props: SettingsSegmentedProps<T, JSX.Element>) {
  const variant = () => (props.mode === "buttons" ? props.variant : undefined);
  return (
    <div
      class={[
        "settings-segmented",
        props.class,
        { [`settings-segmented--${variant()}`]: Boolean(variant()) },
      ]}
      role={props.ariaLabel ? "group" : undefined}
      aria-label={props.ariaLabel}
    >
      <For each={props.options} keyed={(option) => option.value}>
        {(option) => (
          <button
            type="button"
            class={[
              "settings-segmented__btn",
              {
                "settings-segmented__btn--active": option().value === props.value,
                "btn btn--sm": variant() === "accent",
              },
            ]}
            aria-pressed={
              props.mode === "buttons" && props.ariaPressed === false
                ? undefined
                : option().value === props.value
                  ? "true"
                  : "false"
            }
            aria-label={option().ariaLabel}
            data-compact-label={option().compactLabel}
            data-test-id={option().testId}
            title={option().title}
            disabled={props.disabled || option().disabled}
            onClick={(event) => {
              if (props.mode !== "buttons") {
                return;
              }
              props.onClick?.(event, option().value);
              if (event.defaultPrevented || props.disabled || option().disabled) {
                return;
              }
              if (option().value === props.value) {
                props.onReselect?.(option().value);
              } else {
                props.onChange(option().value);
              }
            }}
          >
            {option().label}
          </button>
        )}
      </For>
    </div>
  );
}

export function SettingsStatus(props: {
  kind: SettingsStatusKind;
  label: JSX.Element;
  dot?: boolean;
  carapace?: boolean;
}) {
  return (
    <span
      class={[
        "settings-status",
        props.kind === "muted" ? undefined : `settings-status--${props.kind}`,
        props.carapace ? `oc-status ${CARAPACE_STATUS_CLASS[props.kind]}` : undefined,
      ]}
    >
      <Show when={props.dot !== false}>
        <span class={["settings-status__dot", { "oc-status-indicator": props.carapace }]} />
      </Show>
      <span class={{ "oc-status-label": props.carapace }}>{props.label}</span>
    </span>
  );
}

export function SettingsValue(props: { value: JSX.Element; mono?: boolean }) {
  return (
    <span class={["settings-row__value", { "settings-row__value--mono": props.mono }]}>
      {props.value}
    </span>
  );
}

export function SettingsEmpty(props: { message: JSX.Element; carapace?: boolean }) {
  return (
    <Show when={props.carapace} fallback={<div class="settings-empty">{props.message}</div>}>
      <div class="settings-empty oc-empty">
        <div class="oc-empty-content">
          <p class="oc-empty-description">{props.message}</p>
        </div>
      </div>
    </Show>
  );
}

export function SettingsLoadingSkeleton(props: {
  label?: string;
  rows?: number;
  carapace?: boolean;
}) {
  return (
    <div
      class="settings-loading-skeleton"
      role="status"
      aria-busy="true"
      aria-label={props.label ?? t("common.loading")}
    >
      <div class="settings-loading-skeleton__rows" aria-hidden="true">
        <For each={Array.from({ length: Math.max(1, props.rows ?? 3) }, (_, index) => index)}>
          {(index) => (
            <div
              class={[
                "settings-row settings-loading-skeleton__row",
                { "oc-settings-row": props.carapace },
              ]}
            >
              <div class={["settings-row__text", { "oc-settings-row-content": props.carapace }]}>
                <span
                  class={[
                    "skeleton settings-loading-skeleton__title",
                    { "oc-skeleton-line oc-skeleton-line-short": props.carapace },
                  ]}
                />
                <span
                  class={[
                    "skeleton settings-loading-skeleton__description",
                    { "oc-skeleton-line": props.carapace },
                  ]}
                />
              </div>
              <div class="settings-row__control">
                <span
                  class={[
                    "skeleton settings-loading-skeleton__control",
                    { "settings-loading-skeleton__control--wide": index % 2 === 0 },
                  ]}
                />
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

export function SettingsSecretInput(props: {
  ariaLabel: string;
  value: string;
  placeholder?: string;
  visible: boolean;
  disabled?: boolean;
  showLabel: string;
  hideLabel: string;
  toggleLabel: string;
  onInput: (next: string) => void;
  onToggle: () => void;
}) {
  return (
    <span class="settings-secret">
      <input
        class="settings-input"
        type={props.visible ? "text" : "password"}
        aria-label={props.ariaLabel}
        autocomplete="off"
        spellcheck="false"
        value={props.value}
        placeholder={props.placeholder ?? ""}
        disabled={props.disabled}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
      <openclaw-tooltip prop:content={props.visible ? props.hideLabel : props.showLabel}>
        <button
          type="button"
          class="settings-secret__toggle"
          aria-label={props.toggleLabel}
          aria-pressed={props.visible ? "true" : "false"}
          disabled={props.disabled}
          onClick={() => props.onToggle()}
        >
          <Icon name={props.visible ? "eye" : "eyeOff"} />
        </button>
      </openclaw-tooltip>
    </span>
  );
}
