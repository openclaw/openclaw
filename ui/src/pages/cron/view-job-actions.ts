import { html, nothing } from "lit";
import { isSystemMonitorDeclaration } from "../../../../src/cron/system-owned-declaration.js";
import type { CronJob } from "../../api/types.ts";
import { icon } from "../../components/icons.ts";
import { renderSettingsToggle } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { CronProps } from "./view-types.ts";

// Run now and pause/resume are visible controls (rows and detail header);
// the menu only carries the low-traffic actions.
export function renderJobMenu(props: CronProps, job: CronJob) {
  if (!props.canManage) {
    return nothing;
  }
  const systemOwned = isSystemMonitorDeclaration(job.declarationKey);
  const displayName = job.displayName ?? job.name;
  return html`
    <wa-dropdown
      class="cron-job-menu"
      placement="bottom-end"
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        if (!props.canManage) {
          return;
        }
        switch (event.detail.item.value) {
          case "run-if-due":
            props.onRun(job, "due");
            break;
          case "clone":
            if (!systemOwned) {
              props.onClone(job);
            }
            break;
          case "remove":
            if (!systemOwned) {
              props.onRemove(job);
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
        aria-label=${t("cron.actions.moreJob", { name: displayName })}
        title=${t("cron.actions.moreJob", { name: displayName })}
      >
        ${icon("moreHorizontal")}
      </button>
      ${renderMenuItem(props, "run-if-due", t("cron.actions.runIfDue"))}
      ${systemOwned ? nothing : renderMenuItem(props, "clone", t("cron.actions.clone"))}
      ${
        systemOwned
          ? nothing
          : renderMenuItem(props, "remove", t("cron.actions.remove"), { danger: true })
      }
    </wa-dropdown>
  `;
}

export function renderEnabledSwitch(
  props: CronProps,
  job: CronJob,
  opts?: { compact?: boolean; testId?: string },
) {
  const stateLabel = job.enabled ? t("cron.detail.active") : t("cron.detail.paused");
  const actionLabel = t(job.enabled ? "cron.actions.pauseJob" : "cron.actions.resumeJob", {
    name: job.displayName ?? job.name,
  });
  return html`
    <span
      class="cron-enabled-toggle"
      data-test-id=${opts?.testId ?? "cron-toggle-enabled"}
      title=${opts?.compact ? actionLabel : nothing}
    >
      ${renderSettingsToggle({
        checked: job.enabled,
        disabled: props.busy || !props.canManage,
        ariaLabel: opts?.compact ? actionLabel : stateLabel,
        onChange: (checked) => {
          if (props.canManage) {
            props.onToggle(job, checked);
          }
        },
      })}
      ${opts?.compact ? nothing : html`<span class="cron-detail-sub">${stateLabel}</span>`}
    </span>
  `;
}

function renderMenuItem(
  props: CronProps,
  value: string,
  label: string,
  options?: { danger?: boolean },
) {
  return html`
    <wa-dropdown-item
      class=${options?.danger ? "cron-job-menu__item danger" : "cron-job-menu__item"}
      value=${value}
      variant=${options?.danger ? "danger" : "default"}
      ?disabled=${props.busy || !props.canManage}
    >
      ${label}
    </wa-dropdown-item>
  `;
}
