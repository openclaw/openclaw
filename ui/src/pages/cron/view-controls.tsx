import type { JSX } from "@solidjs/web";
import { createMemo, createEffect, For } from "solid-js";
import { isSystemMonitorDeclaration } from "../../../../src/cron/system-owned-declaration.js";
import type { CronJob } from "../../api/types.ts";
import { renderChannelIcon } from "../../components/channel-icon.ts";
import type { ChannelPickerOption } from "../../components/channel-picker.ts";
import { renderProviderBrandIcon } from "../../components/provider-icon.ts";
import type { PickerParams } from "../../components/select-picker.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsToggle } from "../../components/solid/settings-ui.tsx";
import { syncTabGroupLabel } from "../../components/web-awesome-tabs.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { CronProps } from "./view-types.ts";
import "../../components/web-awesome.ts";
import "../../styles/cron-jobs-pagination.css";
import "../../styles/hub-tabs.css";
// The picker still owns Lit children; its leading-content callbacks keep that contract.
export function CronPicker(props: {
  params: PickerParams<ChannelPickerOption>;
  channel?: boolean;
}) {
  return (
    <openclaw-select-picker
      class={[
        "settings-select picker-select",
        props.params.className,
        { "channel-picker": props.channel },
      ]}
      style={{ width: "100%", "min-width": "min(138px,100%)" }}
      prop:params={
        props.channel
          ? {
              ...props.params,
              renderLeading: (option: ChannelPickerOption) =>
                option.kind === "neutral"
                  ? undefined
                  : renderChannelIcon(option.value, option.label, "picker"),
            }
          : props.params
      }
    />
  );
}
type CronModelOption = {
  value: string;
  label: string;
  provider?: string;
  detail?: string;
  disabled?: boolean;
};
type CronModelParams = {
  id?: string;
  label: string;
  value: string;
  options: readonly CronModelOption[];
  custom: {
    id: string;
    label: string;
    placeholder: string;
    invalid: boolean;
    describedBy?: string;
  };
  onChange: (value: string) => void;
};
export function CronModelPicker(props: { params: CronModelParams }) {
  const customValue = createMemo(() => {
    let value = "__openclaw_custom_model__";
    const values = new Set([
      props.params.value,
      ...props.params.options.map((option) => option.value),
    ]);
    while (values.has(value)) {
      value += "_";
    }
    return value;
  });
  const options = createMemo(() => {
    const entries: Array<
      CronModelOption & {
        description?: string;
      }
    > = [
      ...props.params.options.map((option) => ({ ...option, description: option.detail })),
      { value: customValue(), label: props.params.custom.label },
    ];
    const selected = entries.findIndex((option) => option.value === props.params.value);
    if (selected > 0) {
      entries.unshift(...entries.splice(selected, 1));
    }
    return entries;
  });
  const selected = createMemo(() =>
    options().some((option) => option.value === props.params.value),
  );
  return (
    <div class="model-picker">
      <openclaw-select-picker
        class="settings-select picker-select model-picker__select"
        style={{ width: "100%", "min-width": "min(138px,100%)" }}
        prop:params={{
          id: props.params.id,
          label: props.params.label,
          value: props.params.value,
          options: options(),
          searchable: true,
          showOptionTooltips: false,
          renderLeading: (option: CronModelOption) =>
            option.provider
              ? renderProviderBrandIcon(option.provider, {
                  className: "model-picker__provider-icon",
                })
              : undefined,
          onChange: props.params.onChange,
          onChangeTarget: (value: string, picker: HTMLElement) => {
            const input = picker
              .closest(".model-picker")
              ?.querySelector<HTMLInputElement>(".model-picker__custom");
            if (value === customValue() && input) {
              input.hidden = false;
              queueMicrotask(() => input.focus());
              return;
            }
            if (input) {
              input.hidden = true;
            }
            props.params.onChange(value);
          },
        }}
      />
      <input
        id={props.params.custom.id}
        class="settings-input model-picker__custom"
        aria-label={props.params.custom.label}
        aria-invalid={props.params.custom.invalid ? "true" : "false"}
        aria-describedby={props.params.custom.describedBy}
        placeholder={props.params.custom.placeholder}
        prop:value={props.params.value}
        hidden={selected()}
        onInput={(event) => props.params.onChange(event.currentTarget.value)}
      />
    </div>
  );
}
export function CronJobsPagination(props: {
  params: {
    jobsShown: number;
    jobsTotal: number;
    hasMore: boolean;
    loading: boolean;
    loadingMore: boolean;
    onLoadMore: () => void;
  };
}) {
  return (
    <div class="cron-table__footer">
      <span class="muted">
        {t("cron.list.shownOf", {
          shown: String(props.params.jobsShown),
          total: String(Math.max(props.params.jobsTotal, props.params.jobsShown)),
        })}
      </span>
      {props.params.hasMore ? (
        <button
          class="btn btn--sm cron-load-more"
          disabled={props.params.loading || props.params.loadingMore}
          onClick={() => props.params.onLoadMore()}
        >
          {t(props.params.loadingMore ? "cron.list.loading" : "cron.list.loadMore")}
        </button>
      ) : undefined}
    </div>
  );
}
type CronTab<T extends string> = {
  value: T;
  label: JSX.Element;
  testId?: string;
};
type CronTabsParams<T extends string> = {
  id: string;
  active: T;
  tabs: readonly CronTab<T>[];
  ariaLabel: string;
  panelId: string;
  className: string;
  variant?: "sub";
  onSelect: (value: T) => void;
};
export function CronTabs<T extends string>(props: { props: CronTabsParams<T> }) {
  let group: HTMLElement | undefined;
  createEffect(
    () => props.props.ariaLabel,
    (label) => syncTabGroupLabel(group, label),
  );
  return (
    <wa-tab-group
      ref={(element) => {
        group = element;
      }}
      class={[
        "hub-tabs",
        `hub-tabs--${props.props.variant ?? "primary"}`,
        `${props.props.id}-hub-tabs`,
        props.props.className,
      ]}
      aria-label={props.props.ariaLabel}
      prop:active={props.props.active}
      activation="manual"
      without-scroll-controls
    >
      <For each={props.props.tabs} keyed={(tab) => tab.value}>
        {(entry) => {
          const tab = () => entry();
          return (
            <wa-tab
              id={`${props.props.id}-tab-${tab().value}`}
              panel={tab().value}
              aria-controls={props.props.panelId}
              class="hub-tab"
              active={props.props.active === tab().value}
              prop:tabIndex={props.props.active === tab().value ? 0 : -1}
              aria-selected={props.props.active === tab().value ? "true" : "false"}
              data-test-id={tab().testId}
              onClick={(event: MouseEvent) => {
                if ((event.detail > 0 || event.isTrusted) && props.props.active !== tab().value) {
                  props.props.onSelect(tab().value);
                }
              }}
              onKeyDown={(event: KeyboardEvent) => {
                if (!event.repeat && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  props.props.onSelect(tab().value);
                }
              }}
            >
              {tab().label}
            </wa-tab>
          );
        }}
      </For>
    </wa-tab-group>
  );
}

export function ErrorBanner(componentProps: { error: string | null }) {
  return createMemo(() =>
    componentProps.error ? (
      <div class="cron-error-banner" role="alert">
        {componentProps.error}
      </div>
    ) : undefined,
  );
}
export function AdminRequired(props: CronProps) {
  return createMemo(() =>
    props.canManage ? undefined : (
      <div class="cron-admin-note" role="note">
        <span aria-hidden="true">
          <Icon name="lock" />
        </span>
        <span>{t("cron.adminRequired")}</span>
      </div>
    ),
  );
}
// Run now and pause/resume are visible controls (rows and detail header);
// the menu only carries the low-traffic actions.
export function JobMenu(componentProps: { props: CronProps; job: CronJob }) {
  const systemOwned = createMemo(() =>
    isSystemMonitorDeclaration(componentProps.job.declarationKey),
  );
  const displayName = createMemo(() => componentProps.job.displayName ?? componentProps.job.name);
  return (
    <wa-dropdown
      class="cron-job-menu"
      placement="bottom-end"
      onWa-select={(
        event: CustomEvent<{
          item: {
            value?: string;
          };
        }>,
      ) => {
        if (!componentProps.props.canManage) {
          return;
        }
        switch (event.detail.item.value) {
          case "run-if-due":
            componentProps.props.onRun(componentProps.job, "due");
            break;
          case "clone":
            if (!systemOwned()) {
              componentProps.props.onClone(componentProps.job);
            }
            break;
          case "remove":
            if (!systemOwned()) {
              componentProps.props.onRemove(componentProps.job);
            }
            break;
          case undefined:
            break;
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="btn btn--sm btn--ghost cron-job-menu__trigger"
        aria-label={t("cron.actions.moreJob", { name: displayName() })}
        title={t("cron.actions.moreJob", { name: displayName() })}
      >
        <Icon name="moreHorizontal" />
      </button>
      <MenuItem
        props={componentProps.props}
        value="run-if-due"
        label={t("cron.actions.runIfDue")}
      />
      {systemOwned() ? undefined : (
        <MenuItem props={componentProps.props} value="clone" label={t("cron.actions.clone")} />
      )}
      {systemOwned() ? undefined : (
        <MenuItem
          props={componentProps.props}
          value="remove"
          label={t("cron.actions.remove")}
          danger
        />
      )}
    </wa-dropdown>
  );
}
export function EnabledSwitch(componentProps: {
  props: CronProps;
  job: CronJob;
  compact?: boolean;
}) {
  const stateLabel = createMemo(() =>
    componentProps.job.enabled ? t("cron.detail.active") : t("cron.detail.paused"),
  );
  const actionLabel = createMemo(() =>
    t(componentProps.job.enabled ? "cron.actions.pauseJob" : "cron.actions.resumeJob", {
      name: componentProps.job.displayName ?? componentProps.job.name,
    }),
  );
  return (
    <span
      class="cron-enabled-toggle"
      data-test-id={
        (componentProps.compact ?? false)
          ? `cron-row-toggle-${componentProps.job.id}`
          : "cron-toggle-enabled"
      }
      title={(componentProps.compact ?? false) ? actionLabel() : undefined}
    >
      <SettingsToggle
        checked={componentProps.job.enabled}
        disabled={componentProps.props.busy || !componentProps.props.canManage}
        ariaLabel={(componentProps.compact ?? false) ? actionLabel() : stateLabel()}
        onChange={(checked) => {
          if (componentProps.props.canManage) {
            componentProps.props.onToggle(componentProps.job, checked);
          }
        }}
      />
      {(componentProps.compact ?? false) ? undefined : (
        <span class="cron-detail-sub">{stateLabel()}</span>
      )}
    </span>
  );
}
function MenuItem(componentProps: {
  props: CronProps;
  value: string;
  label: string;
  danger?: boolean;
}) {
  return (
    <wa-dropdown-item
      class={
        (componentProps.danger ?? false) ? "cron-job-menu__item danger" : "cron-job-menu__item"
      }
      value={componentProps.value}
      variant={(componentProps.danger ?? false) ? "danger" : "default"}
      disabled={componentProps.props.busy || !componentProps.props.canManage}
    >
      {componentProps.label}
    </wa-dropdown-item>
  );
}
