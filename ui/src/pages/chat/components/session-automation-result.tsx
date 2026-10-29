import { Show } from "solid-js";
import type { CronCompactJob } from "../../../api/types.ts";
import { RelativeTime } from "../../../components/relative-time.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { DetailsAutomation } from "../chat-details-snapshot.ts";

registerEnglishCatalog(registerChatSessionEnglish);

export function automationResultData(job: CronCompactJob) {
  const runAt = job.lastRunAtMs;
  const triggerAt = job.lastTriggerEvalAtMs;
  return {
    summary: job.lastMeaningfulResult?.summary,
    checkedAt:
      runAt == null ? triggerAt : Math.max(runAt + (job.lastDurationMs ?? 0), triggerAt ?? 0),
    failed: job.lastRunStatus === "error" || undefined,
  };
}

// The job owns task progress; check freshness is separate from that last meaningful result.
export function SessionAutomationResult(
  props: { job: CronCompactJob } | { data: DetailsAutomation["result"] },
) {
  const data = () => ("job" in props ? automationResultData(props.job) : props.data);
  return (
    <Show when={data().summary || data().checkedAt !== undefined}>
      <span class="session-automation-result">
        <Show when={data().failed}>
          <span class="session-automation-result__error">
            {t("chat.sessionDetails.automationCheckFailed")}
          </span>
        </Show>
        <Show when={data().summary}>
          {(result) => (
            <span class="session-automation-result__summary" title={result()}>
              {result()}
            </span>
          )}
        </Show>
        <Show when={data().checkedAt !== undefined}>
          <span class="session-automation-result__checked">
            {t("chat.sessionDetails.automationChecked")}{" "}
            <RelativeTime timestampMs={data().checkedAt} />
          </span>
        </Show>
      </span>
    </Show>
  );
}
