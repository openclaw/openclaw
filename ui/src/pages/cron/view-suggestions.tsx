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
  const lists = createMemo(() =>
    Object.entries({
      "cron-agent-suggestions": props.agentSuggestions,
      "cron-thinking-suggestions": props.thinkingSuggestions,
      "cron-tz-suggestions": props.timezoneSuggestions,
      "cron-delivery-to-suggestions": props.deliveryToSuggestions,
      "cron-failure-alert-to-suggestions": props.failureAlertToSuggestions,
      "cron-delivery-account-suggestions": props.accountSuggestions,
    })
      .map(([id, options]) => ({ id, options: normalizeUniqueStringEntries(options) }))
      .filter((list) => list.options.length > 0),
  );
  return (
    <For each={lists()} keyed={(list) => list.id}>
      {(list) => (
        <datalist id={list().id}>
          <For each={list().options}>{(value) => <option value={value} />}</For>
        </datalist>
      )}
    </For>
  );
}
