import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { createMemo, For } from "solid-js";
import type { CronProps } from "./view-types.ts";
export function CronSuggestionLists(
  props: Pick<
    CronProps,
    | "agentSuggestions"
    | "thinkingSuggestions"
    | "timezoneSuggestions"
    | "deliveryToSuggestions"
    | "failureAlertToSuggestions"
    | "accountSuggestions"
  >,
) {
  return createMemo(() =>
    Object.entries({
      "cron-agent-suggestions": props.agentSuggestions,
      "cron-thinking-suggestions": props.thinkingSuggestions,
      "cron-tz-suggestions": props.timezoneSuggestions,
      "cron-delivery-to-suggestions": props.deliveryToSuggestions,
      "cron-failure-alert-to-suggestions": props.failureAlertToSuggestions,
      "cron-delivery-account-suggestions": props.accountSuggestions,
    }).map(([id, options]) => {
      const clean = normalizeUniqueStringEntries(options);
      return clean.length === 0 ? undefined : (
        <datalist id={id}>
          <For each={clean}>{(value) => <option value={value} />}</For>
        </datalist>
      );
    }),
  );
}
