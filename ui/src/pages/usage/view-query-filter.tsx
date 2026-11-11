import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { createMemo } from "solid-js";
import type { extractQueryTerms } from "../../../../src/shared/usage-query.js";
import type { OverlayPlacement } from "../../components/overlay-anchor.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { setQueryTokensForKey } from "./query.ts";
import { UsageValuePicker, type UsageValueOption } from "./view-value-picker.tsx";

export type UsageQueryFilterKey = "channel" | "provider" | "model" | "tool";

/** The selected `key:value` tokens of one field, as written in the query draft. */
export function usageQueryFieldValues(
  terms: ReturnType<typeof extractQueryTerms>,
  filterKey: string,
): string[] {
  const normalized = normalizeLowercaseStringOrEmpty(filterKey);
  return terms
    .filter((term) => normalizeLowercaseStringOrEmpty(term.key ?? "") === normalized)
    .map((term) => term.value)
    .filter(Boolean);
}

/** A field's values with their session counts, plus selected values the range no longer has. */
export function usageQueryFieldOptions(
  options: readonly string[],
  counts: Readonly<Record<string, number>> | undefined,
  selected: readonly string[],
): UsageValueOption[] {
  const known = new Set(options.map((value) => normalizeLowercaseStringOrEmpty(value)));
  return [
    ...options.map((value) => ({
      value,
      label: value,
      count: counts && Object.hasOwn(counts, value) ? counts[value] : undefined,
    })),
    ...selected
      .filter((value) => !known.has(normalizeLowercaseStringOrEmpty(value)))
      .map((value) => ({ value, label: value })),
  ];
}

/** Toggles one value of a field in the query draft; the query applies with Filter or Enter. */
export function toggleUsageQueryValue(
  queryDraft: string,
  filterKey: string,
  selected: readonly string[],
  value: string,
): string {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  return setQueryTokensForKey(
    queryDraft,
    filterKey,
    selected.some((entry) => normalizeLowercaseStringOrEmpty(entry) === normalized)
      ? selected.filter((entry) => normalizeLowercaseStringOrEmpty(entry) !== normalized)
      : [...selected, value],
  );
}

export function usageQueryFilterSearchLabel(filterKey: UsageQueryFilterKey): string {
  return t(`usage.filters.search.${filterKey}`);
}

export function UsageQueryFilter(props: {
  filterKey: UsageQueryFilterKey;
  label: string;
  options: string[];
  counts?: Readonly<Record<string, number>>;
  queryDraft: string;
  queryTerms: ReturnType<typeof extractQueryTerms>;
  onQueryDraftChange: (value: string) => void;
  placement?: OverlayPlacement;
}) {
  const selected = createMemo(() => usageQueryFieldValues(props.queryTerms, props.filterKey));
  const selectedSet = createMemo(
    () => new Set(selected().map((value) => normalizeLowercaseStringOrEmpty(value))),
  );
  const options = createMemo(() => usageQueryFieldOptions(props.options, props.counts, selected()));
  // The pill renders before its options load so the filter row keeps its height.
  return (
    <UsageValuePicker
      id={props.filterKey}
      label={`${props.label} ${selected().length > 0 ? selected().length : t("usage.filters.all")}`}
      class="usage-filter-select"
      triggerClass="usage-filter-trigger"
      placement={props.placement ?? "bottom-start"}
      multiple
      options={options}
      isSelected={(value) => selectedSet().has(normalizeLowercaseStringOrEmpty(value))}
      searchLabel={() => usageQueryFilterSearchLabel(props.filterKey)}
      onToggle={(value) =>
        props.onQueryDraftChange(
          toggleUsageQueryValue(props.queryDraft, props.filterKey, selected(), value),
        )
      }
      onClear={() =>
        props.onQueryDraftChange(setQueryTokensForKey(props.queryDraft, props.filterKey, []))
      }
      onSelectAll={(values) =>
        props.onQueryDraftChange(
          setQueryTokensForKey(props.queryDraft, props.filterKey, [
            ...selected(),
            ...values.filter((value) => !selectedSet().has(normalizeLowercaseStringOrEmpty(value))),
          ]),
        )
      }
      trigger={
        <>
          <span>{props.label}</span>
          <span class="settings-count">
            {selected().length > 0 ? selected().length : t("usage.filters.all")}
          </span>
        </>
      }
    />
  );
}
