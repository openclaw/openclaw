import type { JSX } from "@solidjs/web";
import type { CronJob } from "../../api/types.ts";
import { AgentRowChip } from "../../components/agent-row-chip.tsx";
import { IconButton, ROW_GLYPH_STROKE } from "../../components/solid/icon-button.tsx";
import { sessionIcon } from "../../components/solid/icon.tsx";
import { isCronJobActiveFailure, isCronJobRunning } from "../../lib/cron-status.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { EnabledSwitch, JobMenu } from "./view-controls.tsx";
import {
  describeJobNextRun,
  JobSchedule,
  JobStateIndicator,
  TriggerIndicator,
  DisabledNote,
  LastRunCell,
  SuccessfulLastRun,
} from "./view-job-status.tsx";
import type { CronJobActionProps, CronProps } from "./view-types.ts";
export function JobRow(
  props: CronJobActionProps &
    Pick<CronProps, "jobs" | "onSelectJob" | "focus" | "phoneLayout"> & {
      job: CronJob;
      index: number;
      count: number;
      rowRef: (node: HTMLDivElement) => void;
      onFocus: () => void;
      style?: JSX.CSSProperties;
    },
) {
  const displayName = () => props.job.displayName ?? props.job.name;
  const description = () => props.job.description?.trim();
  return (
    <div
      ref={props.rowRef}
      class={[
        "cron-table__row",
        {
          "cron-table__row--paused": !props.job.enabled,
          "cron-table__row--read-only": !props.phoneLayout && !props.canManage,
        },
      ]}
      role="listitem"
      aria-posinset={props.index + 1}
      aria-setsize={props.count}
      data-index={props.index}
      style={props.style}
      onFocusIn={() => props.onFocus()}
      data-test-id={`cron-row-${props.job.id}`}
      onClick={() => {
        const job = props.jobs.find((entry) => entry.id === props.job.id);
        if (job) {
          props.onSelectJob(job);
        }
      }}
    >
      {!props.phoneLayout && props.canManage ? (
        <span class="cron-table__toggle" onClick={(event) => event.stopPropagation()}>
          <EnabledSwitch {...props} job={props.job} compact />
        </span>
      ) : undefined}
      {props.phoneLayout ? (
        <>
          <button ref={props.focus?.ref(props.job.id)} type="button" class="cron-table__name">
            <JobStateIndicator job={props.job} />
            <span class="cron-table__name-copy">
              <span class="cron-table__name-line">
                <span class="cron-table__name-text">{displayName()}</span>
                {props.job.trigger ? <TriggerIndicator /> : undefined}
              </span>
              <AgentRowChip agentId={props.job.agentId} />
              {description() || !props.job.enabled ? (
                <span class="cron-table__name-meta">
                  {description() ? (
                    <span
                      class="cron-table__description"
                      data-test-id={`cron-row-description-${props.job.id}`}
                      title={`${t("cron.form.description")}: ${description()}`}
                    >
                      {description()}
                    </span>
                  ) : undefined}
                  {description() && !props.job.enabled ? (
                    <span class="cron-table__meta-separator" aria-hidden="true">
                      ·
                    </span>
                  ) : undefined}
                  {props.job.enabled ? undefined : <DisabledNote job={props.job} />}
                </span>
              ) : undefined}
            </span>
          </button>
          <span class="cron-table__meta">
            <JobCell
              class="cron-table__schedule"
              label={t("cron.jobs.schedule")}
              value={<JobSchedule job={props.job} />}
            />
            <JobCell
              class="cron-table__next"
              label={t("cron.jobs.nextRun")}
              value={
                <span
                  class={{
                    "cron-table__running": isCronJobRunning(props.job),
                    "cron-table__waiting": Boolean(props.job.state?.admissionDeferred),
                  }}
                >
                  {describeJobNextRun(props.job)}
                </span>
              }
            />
            <JobCell
              class="cron-table__last"
              label={t("cron.jobs.lastRun")}
              value={<LastRunCell job={props.job} />}
            />
          </span>
        </>
      ) : (
        <>
          <button ref={props.focus?.ref(props.job.id)} type="button" class="cron-table__name">
            <span class="cron-table__name-copy">
              <span class="cron-table__name-line">
                <span class="cron-table__name-text">{displayName()}</span>
                <JobStateIndicator job={props.job} />
                {props.job.trigger ? <TriggerIndicator /> : undefined}
              </span>
              <span class="cron-table__name-meta">
                <JobCell
                  class="cron-table__schedule"
                  label={t("cron.jobs.schedule")}
                  value={<JobSchedule job={props.job} />}
                />
                <AgentRowChip agentId={props.job.agentId} />
                <SuccessfulLastRun job={props.job} />
                {description() ? (
                  <span
                    class="cron-table__description"
                    data-test-id={`cron-row-description-${props.job.id}`}
                    title={`${t("cron.form.description")}: ${description()}`}
                  >
                    {description()}
                  </span>
                ) : undefined}
              </span>
              {isCronJobActiveFailure(props.job) ? (
                <span class="cron-table__failure">
                  {props.job.state?.autoDisabled ? (
                    <DisabledNote job={props.job} />
                  ) : (
                    t("cron.list.lastRunFailed")
                  )}
                </span>
              ) : undefined}
            </span>
          </button>
          <JobCell
            class="cron-table__next"
            label={t("cron.jobs.nextRun")}
            value={
              <span
                class={{
                  "cron-table__running": isCronJobRunning(props.job),
                  "cron-table__waiting": Boolean(props.job.state?.admissionDeferred),
                }}
              >
                {describeJobNextRun(props.job)}
              </span>
            }
          />
        </>
      )}
      {props.canManage ? (
        <span class="cron-table__actions" onClick={(e: Event) => e.stopPropagation()}>
          <IconButton
            size={28}
            glyph="row"
            class="cron-row-run"
            data-test-id={`cron-row-run-${props.job.id}`}
            label={t(
              props.phoneLayout ? "cron.actions.runNowJob" : "cron.actions.runNowAutomation",
              {
                name: displayName(),
              },
            )}
            icon={sessionIcon("play", 12, ROW_GLYPH_STROKE)}
            disabled={props.busy || !props.connected}
            onClick={() => props.onRun(props.job, "force")}
          />
          {props.phoneLayout ? <EnabledSwitch {...props} job={props.job} compact /> : undefined}
          <JobMenu
            {...props}
            job={props.job}
            onClone={() => {
              const job = props.jobs.find((entry) => entry.id === props.job.id);
              if (job) {
                props.onClone(job);
              }
            }}
          />
        </span>
      ) : undefined}
    </div>
  );
}
function JobCell(props: { class: string; label: string; value: JSX.Element }) {
  return (
    <span class={["cron-table__cell", props.class]}>
      <span class="cron-table__cell-label">{props.label}</span>
      <span class="cron-table__cell-value">{props.value}</span>
    </span>
  );
}
