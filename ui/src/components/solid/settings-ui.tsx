import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import { t } from "../../i18n/index.ts";

type SettingsStatusKind = "ok" | "warn" | "danger" | "accent" | "muted";

const CARAPACE_STATUS_CLASS: Record<SettingsStatusKind, string> = {
  accent: "oc-status-info",
  danger: "oc-status-error",
  muted: "",
  ok: "oc-status-success",
  warn: "oc-status-warning",
};

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
      {(props.title || props.description || props.actions) && (
        <div class={["settings-section__header", { "oc-settings-section-header": props.carapace }]}>
          {(props.title || props.description) && (
            <div
              class={["settings-section__copy", { "oc-settings-section-heading": props.carapace }]}
            >
              {props.title && (
                <h2
                  class={[
                    "settings-section__heading",
                    { "oc-settings-section-title": props.carapace },
                  ]}
                >
                  {props.title}
                  {props.count !== undefined && <span class="settings-count">{props.count}</span>}
                </h2>
              )}
              {props.description && <p class="settings-section__desc">{props.description}</p>}
            </div>
          )}
          {props.actions && <div class="settings-section__actions">{props.actions}</div>}
        </div>
      )}
      {props.notice}
      <div
        class={[
          "settings-group",
          { "settings-group--danger": props.danger, "oc-settings-group": props.carapace },
        ]}
      >
        {props.children}
      </div>
    </section>
  );
}

export function SettingsRow(props: {
  title: JSX.Element;
  description?: JSX.Element;
  control?: JSX.Element;
  carapace?: boolean;
  stacked?: boolean;
  stackedOnNarrow?: boolean;
  role?: "alert" | "status";
}) {
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
      <div class={["settings-row__text", { "oc-settings-row-content": props.carapace }]}>
        <span class={["settings-row__title", { "oc-settings-row-title": props.carapace }]}>
          {props.title}
        </span>
        {props.description && (
          <span class={["settings-row__desc", { "oc-settings-row-description": props.carapace }]}>
            {props.description}
          </span>
        )}
      </div>
      {props.control !== undefined && (
        <div class={["settings-row__control", { "oc-settings-row-control": props.carapace }]}>
          {props.control}
        </div>
      )}
    </div>
  );
}

export function SettingsToggle(props: {
  checked: boolean;
  onChange: (checked: boolean) => boolean | void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      class="settings-toggle"
      checked={props.checked}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      onChange={(event) => {
        const checked = props.checked;
        if (props.onChange(event.currentTarget.checked) === false) {
          event.currentTarget.checked = checked;
        }
      }}
    />
  );
}

export function SettingsDefaultDescription(props: { value: string; overridden: boolean }) {
  return <>{props.overridden && t("configForm.defaultValue", { value: props.value })}</>;
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
        props.kind !== "muted" && `settings-status--${props.kind}`,
        props.carapace && `oc-status ${CARAPACE_STATUS_CLASS[props.kind]}`,
      ]}
    >
      {props.dot !== false && (
        <span class={["settings-status__dot", { "oc-status-indicator": props.carapace }]} />
      )}
      <span class={props.carapace ? "oc-status-label" : undefined}>{props.label}</span>
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
    <>
      {props.carapace ? (
        <div class="settings-empty oc-empty">
          <div class="oc-empty-content">
            <p class="oc-empty-description">{props.message}</p>
          </div>
        </div>
      ) : (
        <div class="settings-empty">{props.message}</div>
      )}
    </>
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
