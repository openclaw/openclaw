import { createMemo, For } from "solid-js";
import type { CronProps } from "./view-types.ts";
export function CronSuggestionLists(
  props: Pick<
    CronProps,
    | "timezoneSuggestions"
    | "deliveryToSuggestions"
    | "failureAlertToSuggestions"
    | "accountSuggestions"
  >,
) {
  const lists = createMemo(() =>
    [
      { id: "cron-tz-suggestions", options: props.timezoneSuggestions },
      { id: "cron-delivery-to-suggestions", options: props.deliveryToSuggestions },
      { id: "cron-failure-alert-to-suggestions", options: props.failureAlertToSuggestions },
      { id: "cron-delivery-account-suggestions", options: props.accountSuggestions },
    ].filter((list) => list.options.length > 0),
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
