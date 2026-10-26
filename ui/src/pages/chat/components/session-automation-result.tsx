import { Show } from "solid-js";
import type { CronCompactJob } from "../../../api/types.ts";
import { RelativeTime } from "../../../components/relative-time.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatSessionEnglish);

// The job owns task progress; check freshness is separate from that last meaningful result.
export function SessionAutomationResult(props: { job: CronCompactJob }) {
  const checkedAt = () => {
    const runAt = props.job.lastRunAtMs;
    const triggerAt = props.job.lastTriggerEvalAtMs;
    if (runAt == null) {
      return triggerAt;
    }
    return Math.max(runAt + (props.job.lastDurationMs ?? 0), triggerAt ?? 0);
  };
  return (
    <Show when={props.job.lastMeaningfulResult || checkedAt() !== undefined}>
      <span class="session-automation-result">
        <Show when={props.job.lastRunStatus === "error"}>
          <span class="session-automation-result__error">
            {t("chat.sessionDetails.automationCheckFailed")}
          </span>
        </Show>
        <Show when={props.job.lastMeaningfulResult}>
          {(result) => (
            <span class="session-automation-result__summary" title={result().summary}>
              {result().summary}
            </span>
          )}
        </Show>
        <Show when={checkedAt() !== undefined}>
          <span class="session-automation-result__checked">
            {t("chat.sessionDetails.automationChecked")} <RelativeTime timestampMs={checkedAt()} />
          </span>
        </Show>
      </span>
    </Show>
  );
}
