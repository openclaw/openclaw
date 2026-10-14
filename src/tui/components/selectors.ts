import { modelKey } from "../../agents/model-ref-shared.js";
import { searchableSelectListTheme } from "../theme/theme.js";
import type { TuiModelChoice } from "../tui-backend.js";
import { SearchableSelectList, type SearchableSelectItem } from "./searchable-select-list.js";

export function createSearchableSelectList(items: SearchableSelectItem[], maxVisible = 7) {
  return new SearchableSelectList(items, maxVisible, searchableSelectListTheme);
}

/**
 * Lists the current model and recommended models first; other models of a
 * provider that recommends any wait behind an "All models" row.
 */
export function modelSelectItems(
  models: readonly TuiModelChoice[],
  currentRef?: string,
): SearchableSelectItem[] {
  const recommendingProviders = new Set(
    models.filter((model) => model.recommended).map((model) => model.provider),
  );
  const items = models.map((model) => {
    const ref = modelKey(model.provider, model.id);
    return {
      value: ref,
      label: ref,
      description: [
        model.name !== model.id ? model.name : "",
        model.available === false ? (model.unavailableReason ?? "unavailable") : "",
      ]
        .filter(Boolean)
        .join(" · "),
      ...(recommendingProviders.has(model.provider) && !model.recommended && ref !== currentRef
        ? { collapsed: true }
        : {}),
    };
  });
  const collapsed = items.filter((item) => item.collapsed);
  if (collapsed.length === 0) {
    return items;
  }
  return [
    ...items.filter((item) => !item.collapsed),
    { value: "all-models", label: `All models (${collapsed.length})`, expandsCollapsed: true },
    ...collapsed,
  ];
}
