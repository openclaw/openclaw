import { For, Show } from "solid-js";
import type { CronJob } from "../../../api/types.ts";
import { registerChatCiEnglish } from "../../../i18n/locales/en-chat-ci.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type {
  CiAutomationOption,
  CiAutomationOptions,
} from "../../../lib/session-pr-automation-spec.ts";
import type { CiAutomationJobs } from "../../../lib/session-pr-automation.ts";

registerEnglishCatalog(registerChatCiEnglish);

export type ChatCiAutomationProps = {
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
const OPTIONS = [
  ["autoFix", "chat.pullRequests.automationAutoFix"],
  ["autoMerge", "chat.pullRequests.automationAutoMerge"],
  ["autoArchive", "chat.pullRequests.automationAutoArchive"],
] as const;

function JobError(props: { job?: CronJob }) {
  return (
    <Show when={props.job?.state.autoDisabled || props.job?.state.lastError}>
      <div class="chat-ci__automation-job-error" role="status">
        <Show when={props.job?.state.autoDisabled}>
          {(disabled) => (
            <div>
              {t(
                disabled().reason === "schedule-errors"
                  ? "chat.pullRequests.automationScheduleDisabled"
                  : "chat.pullRequests.automationFailureDisabled",
                { count: String(disabled().consecutiveErrors) },
              )}
            </div>
          )}
        </Show>
        <Show when={props.job?.state.lastError}>
          {(error) => <div>{t("chat.pullRequests.automationLastError", { error: error() })}</div>}
        </Show>
      </div>
    </Show>
  );
}

export function ChatCiAutomationView(props: ChatCiAutomationProps) {
  return (
    <div class="chat-ci__automation">
      <fieldset
        class="chat-ci__automation-options"
        aria-label={t("chat.pullRequests.automationLabel")}
        disabled={props.disabled}
      >
        <For each={OPTIONS}>
          {(entry) => (
            <div class="chat-ci__automation-row">
              <label class="chat-ci__automation-option">
                <input
                  class="chat-ci__automation-checkbox"
                  type="checkbox"
                  name={entry[0]}
                  checked={props.options[entry[0]]}
                  disabled={props.pending[entry[0]] !== undefined}
                  onChange={(event) => props.onChange(entry[0], event.currentTarget.checked)}
                />
                <span class="chat-ci__automation-label">{t(entry[1])}</span>
              </label>
              <JobError job={props.jobs?.[entry[0]]} />
            </div>
          )}
        </For>
      </fieldset>
      <Show when={props.schedulerEnabled === false}>
        <p class="chat-ci__automation-warning" role="status">
          {t("chat.pullRequests.automationSchedulerDisabled")}
        </p>
      </Show>
      <Show when={props.disabledReason}>
        {(reason) => (
          <div class="chat-ci__automation-status" role="status">
            {reason()}
          </div>
        )}
      </Show>
      <Show when={props.error}>
        {(error) => (
          <div class="chat-ci__automation-error">
            <span role="alert">{error()}</span>
            <button
              class="chat-ci__automation-retry"
              type="button"
              disabled={props.loading || props.saving || props.retryDisabled}
              onClick={props.onRetry}
            >
              {t("chat.pullRequests.automationRetry")}
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}
