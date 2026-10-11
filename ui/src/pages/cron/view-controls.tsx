import type { CronJob } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsToggle } from "../../components/solid/settings-ui.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { CronProps } from "./view-types.ts";
import "../../components/web-awesome.ts";
export function ErrorBanner(props: { error: string | null }) {
  return (
    <>
      {props.error ? (
        <div class="cron-error-banner" role="alert">
          {props.error}
        </div>
      ) : undefined}
    </>
  );
}
export function AdminRequired(props: CronProps) {
  return (
    <>
      {props.canManage ? undefined : (
        <div class="cron-admin-note" role="note">
          <span aria-hidden="true">
            <Icon name="lock" />
          </span>
          <span>{t("cron.adminRequired")}</span>
        </div>
      )}
    </>
  );
}
// Run now and pause/resume are visible controls (rows and detail header);
// the menu only carries the low-traffic actions.
export function JobMenu(props: CronProps & { job: CronJob }) {
  const displayName = () => props.job.displayName ?? props.job.name;
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
        if (!props.canManage) {
          return;
        }
        switch (event.detail.item.value) {
          case "run-if-due":
            props.onRun(props.job, "due");
            break;
          case "clone":
            props.onClone(props.job);
            break;
          case "remove":
            props.onRemove(props.job);
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
      <MenuItem {...props} value="run-if-due" label={t("cron.actions.runIfDue")} />
      <MenuItem {...props} value="clone" label={t("cron.actions.clone")} />
      <MenuItem {...props} value="remove" label={t("cron.actions.remove")} danger />
    </wa-dropdown>
  );
}
export function EnabledSwitch(
  props: CronProps & {
    job: CronJob;
    compact?: boolean;
  },
) {
  const stateLabel = () => (props.job.enabled ? t("cron.detail.active") : t("cron.detail.paused"));
  const actionLabel = () =>
    t(props.job.enabled ? "cron.actions.pauseJob" : "cron.actions.resumeJob", {
      name: props.job.displayName ?? props.job.name,
    });
  return (
    <span
      class="cron-enabled-toggle"
      data-test-id={props.compact ? `cron-row-toggle-${props.job.id}` : "cron-toggle-enabled"}
      title={props.compact ? actionLabel() : undefined}
    >
      <SettingsToggle
        checked={props.job.enabled}
        disabled={props.busy || !props.canManage}
        ariaLabel={props.compact ? actionLabel() : stateLabel()}
        onChange={(checked) => {
          if (props.canManage) {
            props.onToggle(props.job, checked);
          }
        }}
      />
      {props.compact ? undefined : <span class="cron-detail-sub">{stateLabel()}</span>}
    </span>
  );
}
function MenuItem(
  props: CronProps & {
    value: string;
    label: string;
    danger?: boolean;
  },
) {
  return (
    <wa-dropdown-item
      class={props.danger ? "cron-job-menu__item danger" : "cron-job-menu__item"}
      value={props.value}
      variant={props.danger ? "danger" : "default"}
      disabled={props.busy || !props.canManage}
    >
      {props.label}
    </wa-dropdown-item>
  );
}
