import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { For, Show, createMemo } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { extractQueryTerms } from "./helpers.ts";
import { setQueryTokensForKey } from "./query.ts";

export function UsageQueryFilter(props: {
  filterKey: string;
  label: string;
  options: string[];
  queryDraft: string;
  onQueryDraftChange: (value: string) => void;
}) {
  const selected = createMemo(() => {
    const normalized = normalizeLowercaseStringOrEmpty(props.filterKey);
    return extractQueryTerms(props.queryDraft)
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
  return (
    <Show when={props.options.length > 0}>
      <wa-dropdown
        class="usage-filter-select"
        placement="bottom-start"
        onWa-select={(event: CustomEvent<{ item: { value?: string; checked: boolean } }>) => {
          event.preventDefault();
          const value = event.detail.item.value;
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
          if (value?.startsWith("option:")) {
            const optionValue = decodeURIComponent(value.slice("option:".length));
            props.onQueryDraftChange(
              setQueryTokensForKey(
                props.queryDraft,
                props.filterKey,
                event.detail.item.checked
                  ? [...selected(), optionValue]
                  : selected().filter(
                      (entry) =>
                        normalizeLowercaseStringOrEmpty(entry) !==
                        normalizeLowercaseStringOrEmpty(optionValue),
                    ),
              ),
            );
          }
        }}
      >
        <button slot="trigger" type="button" class="usage-filter-trigger">
          <span>{props.label}</span>
          <span class="settings-count">
            {selected().length > 0 ? selected().length : t("usage.filters.all")}
          </span>
        </button>
        <wa-dropdown-item value="command:select-all" disabled={allSelected()}>
          {t("usage.filters.selectAll")}
        </wa-dropdown-item>
        <wa-dropdown-item value="command:clear" disabled={selected().length === 0}>
          {t("usage.filters.clear")}
        </wa-dropdown-item>
        <div class="session-menu__separator" role="separator" />
        <For each={props.options}>
          {(value) => (
            <wa-dropdown-item
              class="usage-filter-option"
              type="checkbox"
              value={`option:${encodeURIComponent(value)}`}
              prop:checked={selectedSet().has(normalizeLowercaseStringOrEmpty(value))}
            >
              {value}
            </wa-dropdown-item>
          )}
        </For>
      </wa-dropdown>
    </Show>
  );
}
