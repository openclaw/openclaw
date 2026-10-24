import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { createMemo } from "solid-js";
import type { extractQueryTerms } from "../../../../src/shared/usage-query.js";
import { Menu, type MenuItem } from "../../components/solid/menu.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { setQueryTokensForKey } from "./query.ts";

export function UsageQueryFilter(props: {
  filterKey: string;
  label: string;
  options: string[];
  queryDraft: string;
  queryTerms: ReturnType<typeof extractQueryTerms>;
  onQueryDraftChange: (value: string) => void;
}) {
  const selected = createMemo(() => {
    const normalized = normalizeLowercaseStringOrEmpty(props.filterKey);
    return props.queryTerms
      .filter((term) => normalizeLowercaseStringOrEmpty(term.key ?? "") === normalized)
      .map((term) => term.value)
      .filter(Boolean);
  });
  const selectedSet = createMemo(
    () => new Set(selected().map((value) => normalizeLowercaseStringOrEmpty(value))),
  );
  const allSelected = createMemo(() =>
    props.options.every((value) => selectedSet().has(normalizeLowercaseStringOrEmpty(value))),
  );
  const items = createMemo<MenuItem[]>(() => [
    {
      id: "command:select-all",
      label: t("usage.filters.selectAll"),
      disabled: allSelected(),
      closeOnSelect: false,
    },
    {
      id: "command:clear",
      label: t("usage.filters.clear"),
      disabled: selected().length === 0,
      closeOnSelect: false,
    },
    ...props.options.map((value): MenuItem => ({
      id: `option:${encodeURIComponent(value)}`,
      label: value,
      class: "usage-filter-option",
      type: "checkbox",
      checked: selectedSet().has(normalizeLowercaseStringOrEmpty(value)),
      closeOnSelect: false,
    })),
  ]);
  // The pill renders before its options load so the filter row keeps its height.
  return (
    <Menu
      id={`usage-filter-${props.filterKey}`}
      label={`${props.label} ${selected().length > 0 ? selected().length : t("usage.filters.all")}`}
      class="usage-filter-select"
      triggerClass="usage-filter-trigger"
      placement="bottom-start"
      items={items()}
      onSelect={(item) => {
        const value = item.id;
        if (value === "command:select-all") {
          props.onQueryDraftChange(
            setQueryTokensForKey(props.queryDraft, props.filterKey, props.options),
          );
          return;
        }
        if (value === "command:clear") {
          props.onQueryDraftChange(setQueryTokensForKey(props.queryDraft, props.filterKey, []));
          return;
        }
        if (value.startsWith("option:")) {
          const optionValue = decodeURIComponent(value.slice("option:".length));
          props.onQueryDraftChange(
            setQueryTokensForKey(
              props.queryDraft,
              props.filterKey,
              selectedSet().has(normalizeLowercaseStringOrEmpty(optionValue))
                ? selected().filter(
                    (entry) =>
                      normalizeLowercaseStringOrEmpty(entry) !==
                      normalizeLowercaseStringOrEmpty(optionValue),
                  )
                : [...selected(), optionValue],
            ),
          );
        }
      }}
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
