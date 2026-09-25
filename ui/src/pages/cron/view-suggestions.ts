import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { html, nothing } from "lit";
import type { CronProps } from "./view-types.ts";

export function renderCronSuggestionLists(
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
  return Object.entries({
    "cron-agent-suggestions": props.agentSuggestions,
    "cron-thinking-suggestions": props.thinkingSuggestions,
    "cron-tz-suggestions": props.timezoneSuggestions,
    "cron-delivery-to-suggestions": props.deliveryToSuggestions,
    "cron-failure-alert-to-suggestions": props.failureAlertToSuggestions,
    "cron-delivery-account-suggestions": props.accountSuggestions,
  }).map(([id, options]) => {
    const clean = uniqueStrings(normalizeStringEntries(options));
    return clean.length === 0
      ? nothing
      : html`<datalist id=${id}>
          ${clean.map((value) => html`<option value=${value}></option> `)}
        </datalist>`;
  });
}
