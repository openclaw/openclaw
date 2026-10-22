import { createMemo, createUniqueId, Errored, Loading } from "solid-js";
import type { CronJob } from "../../api/types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { Menu } from "../../components/solid/menu.tsx";
import { SettingsToggle } from "../../components/solid/settings-ui.tsx";
import { formatUiError } from "../../lib/format-error.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { CronJobActionProps, CronProps } from "./view-types.ts";
export function ErrorBanner(props: { error: string | null; reads?: CronProps["reads"] }) {
  const modelRequest = createMemo(() => props.reads?.modelRequest());
  return (
    <>
      {props.error ? (
        <div class="cron-error-banner" role="alert">
          {props.error}
        </div>
      ) : props.reads ? (
        <Loading on={modelRequest()}>
          <Errored
            fallback={(error) => (
              <div class="cron-error-banner" role="alert">
                {formatUiError(error())}
              </div>
            )}
          >
            {props.reads.models()}
          </Errored>
        </Loading>
      ) : undefined}
    </>
  );
}
export function NoticeBanner(props: { notice: string | null }) {
  return (
    <>
      {props.notice ? (
        <div class="callout" role="status">
          {props.notice}
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
export function JobMenu(props: CronJobActionProps & { job: CronJob }) {
  const id = createUniqueId();
  const displayName = () => props.job.displayName ?? props.job.name;
  return (
    <Menu
      lazy
      id={id}
      label={t("cron.actions.moreJob", { name: displayName() })}
      class="cron-job-menu"
      triggerClass="btn btn--sm btn--ghost cron-job-menu__trigger"
      triggerAttributes={{ title: t("cron.actions.moreJob", { name: displayName() }) }}
      trigger={<Icon name="moreHorizontal" />}
      placement="bottom-end"
      items={[
        ...(props.job.schedule.kind === "event"
          ? []
          : [
              {
                id: "run-if-due",
                label: t("cron.actions.runIfDue"),
                class: "cron-job-menu__item",
                disabled: props.busy || !props.connected || !props.canManage,
              },
            ]),
        {
          id: "clone",
          label: t("cron.actions.clone"),
          class: "cron-job-menu__item",
          disabled: props.busy || !props.canManage,
        },
        {
          id: "remove",
          label: t("cron.actions.remove"),
          class: "cron-job-menu__item danger",
          variant: "danger",
          disabled: props.busy || !props.connected || !props.canManage,
        },
      ]}
      onSelect={(item) => {
        if (!props.canManage || (!props.connected && item.id !== "clone")) {
          return;
        }
        switch (item.id) {
          case "run-if-due":
            props.onRun(props.job, "due");
            break;
          case "clone":
            props.onClone(props.job);
            break;
          case "remove":
            void props.onRemove(props.job);
            break;
        }
      }}
    />
  );
}
export function EnabledSwitch(
  props: CronJobActionProps & {
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
        disabled={props.busy || !props.connected || !props.canManage}
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
