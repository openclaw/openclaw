import { html, nothing } from "lit";
import { t } from "../../i18n/index.ts";
import { extractQueryTerms } from "./helpers.ts";
import { normalizeQueryText, setQueryTokensForKey } from "./query.ts";

export function renderUsageQueryFilter(
  key: string,
  label: string,
  options: string[],
  queryDraft: string,
  onQueryDraftChange: (value: string) => void,
) {
  if (options.length === 0) {
    return nothing;
  }
  const normalized = normalizeQueryText(key);
  const selected = extractQueryTerms(queryDraft)
    .filter((term) => normalizeQueryText(term.key ?? "") === normalized)
    .map((term) => term.value)
    .filter(Boolean);
  const selectedSet = new Set(selected.map((value) => normalizeQueryText(value)));
  const allSelected =
    options.length > 0 && options.every((value) => selectedSet.has(normalizeQueryText(value)));
  const selectedCount = selected.length;
  return html`
    <wa-dropdown
      class="usage-filter-select"
      placement="bottom-start"
      @wa-select=${(event: CustomEvent<{ item: { value?: string; checked: boolean } }>) => {
        event.preventDefault();
        const value = event.detail.item.value;
        if (value === "command:select-all") {
          onQueryDraftChange(setQueryTokensForKey(queryDraft, key, options));
          return;
        }
        if (value === "command:clear") {
          onQueryDraftChange(setQueryTokensForKey(queryDraft, key, []));
          return;
        }
        if (value?.startsWith("option:")) {
          const optionValue = decodeURIComponent(value.slice("option:".length));
          onQueryDraftChange(
            setQueryTokensForKey(
              queryDraft,
              key,
              event.detail.item.checked
                ? [...selected, optionValue]
                : selected.filter(
                    (entry) => normalizeQueryText(entry) !== normalizeQueryText(optionValue),
                  ),
            ),
          );
        }
      }}
    >
      <button slot="trigger" type="button" class="usage-filter-trigger">
        <span>${label}</span>
        ${
          selectedCount > 0
            ? html`<span class="settings-count">${selectedCount}</span>`
            : html` <span class="settings-count">${t("usage.filters.all")}</span> `
        }
      </button>
      <wa-dropdown-item value="command:select-all" ?disabled=${allSelected}>
        ${t("usage.filters.selectAll")}
      </wa-dropdown-item>
      <wa-dropdown-item value="command:clear" ?disabled=${selectedCount === 0}>
        ${t("usage.filters.clear")}
      </wa-dropdown-item>
      <div class="session-menu__separator" role="separator"></div>
      ${options.map((value) => {
        const checked = selectedSet.has(normalizeQueryText(value));
        return html`
          <wa-dropdown-item
            class="usage-filter-option"
            type="checkbox"
            value=${`option:${encodeURIComponent(value)}`}
            .checked=${checked}
          >
            ${value}
          </wa-dropdown-item>
        `;
      })}
    </wa-dropdown>
  `;
}
