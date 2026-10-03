import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import type { CronJob } from "../../../api/types.ts";
import { pathForRoute } from "../../../app-route-paths.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatCiEnglish } from "../../../i18n/locales/en-chat-ci.ts";
import { isCronJobRunning } from "../../../lib/cron-status.ts";
import { formatMs } from "../../../lib/format.ts";
import type {
  CiAutomationOption,
  CiAutomationOptions,
} from "../../../lib/session-pr-automation-spec.ts";
import type { CiAutomationJobs } from "../../../lib/session-pr-automation.ts";

registerChatCiEnglish();

type ChatCiAutomationProps = {
  options: CiAutomationOptions;
  jobs?: CiAutomationJobs;
  basePath?: string;
  schedulerEnabled?: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  disabled?: boolean;
  disabledReason?: string;
  retryDisabled?: boolean;
  onChange: (option: CiAutomationOption, enabled: boolean) => void;
  onRetry: () => void;
};

const OPTION_LABELS = [
  ["autoFix", "chat.pullRequests.automationAutoFix"],
  ["autoMerge", "chat.pullRequests.automationAutoMerge"],
  ["autoArchive", "chat.pullRequests.automationAutoArchive"],
] as const;

function renderJobState(job: CronJob | undefined, props: ChatCiAutomationProps) {
  if (!job) {
    return nothing;
  }
  const running = isCronJobRunning(job);
  const autoDisabled = job.state.autoDisabled;
  const nextCheck = job.enabled && !running && props.schedulerEnabled && job.state.nextRunAtMs;
  return html`
    <div class="chat-ci__automation-job">
      <div class="chat-ci__automation-job-status">
        <span>
          ${
            running
              ? t(
                  job.enabled
                    ? "chat.pullRequests.automationRunning"
                    : "chat.pullRequests.automationStopping",
                )
              : autoDisabled
                ? t(
                    autoDisabled.reason === "schedule-errors"
                      ? "chat.pullRequests.automationScheduleDisabled"
                      : "chat.pullRequests.automationFailureDisabled",
                    { count: String(autoDisabled.consecutiveErrors) },
                  )
                : nextCheck
                  ? t("chat.pullRequests.automationNextCheck", { time: formatMs(nextCheck) })
                  : t(
                      job.enabled
                        ? "chat.pullRequests.automationEnabled"
                        : "chat.pullRequests.automationOff",
                    )
          }
        </span>
        <a href=${pathForRoute("cron", props.basePath) + "?job=" + encodeURIComponent(job.id)}
          >${t("chat.pullRequests.automationOpenJob")}</a
        >
      </div>
      ${
        job.state.lastError
          ? html`<div class="chat-ci__automation-job-error">
              ${t("chat.pullRequests.automationLastError", { error: job.state.lastError })}
            </div>`
          : nothing
      }
    </div>
  `;
}

export function renderChatCiAutomation(props: ChatCiAutomationProps) {
  const disabled = props.disabled || props.loading || props.saving;
  const status = props.loading
    ? t("chat.pullRequests.automationLoading")
    : props.saving
      ? t("chat.pullRequests.automationSaving")
      : props.disabled
        ? (props.disabledReason ?? t("chat.pullRequests.automationUnavailable"))
        : "";

  return html`
    <div class="chat-ci__automation">
      <fieldset
        class="chat-ci__automation-options"
        aria-label=${t("chat.pullRequests.automationLabel")}
        ?disabled=${disabled}
      >
        ${OPTION_LABELS.map(
          ([option, label]) => html`
            <div class="chat-ci__automation-row">
              <label class="chat-ci__automation-option">
                <input
                  class="chat-ci__automation-checkbox"
                  type="checkbox"
                  name=${option}
                  .checked=${live(props.options[option])}
                  @change=${(event: Event) => {
                    if (event.currentTarget instanceof HTMLInputElement) {
                      const enabled = event.currentTarget.checked;
                      // Only a confirmed Gateway result changes the displayed setting.
                      event.currentTarget.checked = props.options[option];
                      props.onChange(option, enabled);
                    }
                  }}
                />
                <span class="chat-ci__automation-label">${t(label)}</span>
              </label>
              ${renderJobState(props.jobs?.[option], props)}
            </div>
          `,
        )}
      </fieldset>
      ${
        props.schedulerEnabled === false
          ? html`<p class="chat-ci__automation-warning" role="status">
              ${t("chat.pullRequests.automationSchedulerDisabled")}
            </p>`
          : nothing
      }
      <div class="chat-ci__automation-status" role="status">${status}</div>
      ${
        props.error
          ? html`
              <div class="chat-ci__automation-error">
                <span role="alert">${props.error}</span>
                <button
                  class="chat-ci__automation-retry"
                  type="button"
                  ?disabled=${props.loading || props.saving || props.retryDisabled}
                  @click=${props.onRetry}
                >
                  ${t("chat.pullRequests.automationRetry")}
                </button>
              </div>
            `
          : nothing
      }
    </div>
  `;
}
