import { html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import type { CronJob } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatCiEnglish } from "../../../i18n/locales/en-chat-ci.ts";
import type {
  CiAutomationOption,
  CiAutomationOptions,
} from "../../../lib/session-pr-automation-spec.ts";
import type { CiAutomationJobs } from "../../../lib/session-pr-automation.ts";

registerChatCiEnglish();

type ChatCiAutomationProps = {
  options: CiAutomationOptions;
  pending: Partial<CiAutomationOptions>;
  jobs?: CiAutomationJobs;
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

function renderJobError(job: CronJob | undefined) {
  const autoDisabled = job?.state.autoDisabled;
  const lastError = job?.state.lastError;
  if (!autoDisabled && !lastError) {
    return nothing;
  }
  return html`<div class="chat-ci__automation-job-error" role="status">
    ${
      autoDisabled
        ? html`<div>
            ${t(
              autoDisabled.reason === "schedule-errors"
                ? "chat.pullRequests.automationScheduleDisabled"
                : "chat.pullRequests.automationFailureDisabled",
              { count: String(autoDisabled.consecutiveErrors) },
            )}
          </div>`
        : nothing
    }
    ${
      lastError
        ? html`<div>${t("chat.pullRequests.automationLastError", { error: lastError })}</div>`
        : nothing
    }
  </div>`;
}

export function renderChatCiAutomation(props: ChatCiAutomationProps) {
  return html`
    <div class="chat-ci__automation">
      <fieldset
        class="chat-ci__automation-options"
        aria-label=${t("chat.pullRequests.automationLabel")}
        ?disabled=${props.disabled}
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
                  ?disabled=${props.pending[option] !== undefined}
                  @change=${(event: Event) => {
                    if (event.currentTarget instanceof HTMLInputElement) {
                      props.onChange(option, event.currentTarget.checked);
                    }
                  }}
                />
                <span class="chat-ci__automation-label">${t(label)}</span>
              </label>
              ${renderJobError(props.jobs?.[option])}
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
      ${
        props.disabledReason
          ? html`<div class="chat-ci__automation-status" role="status">
              ${props.disabledReason}
            </div>`
          : nothing
      }
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
