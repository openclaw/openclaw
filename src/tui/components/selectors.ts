import { modelKey } from "../../agents/model-ref-shared.js";
import { searchableSelectListTheme } from "../theme/theme.js";
import type { TuiModelChoice } from "../tui-backend.js";
import { SearchableSelectList, type SearchableSelectItem } from "./searchable-select-list.js";

export function createSearchableSelectList(items: SearchableSelectItem[], maxVisible = 7) {
  return new SearchableSelectList(items, maxVisible, searchableSelectListTheme);
}

/**
 * Lists the current model and recommended models first; every other model waits
 * behind an "All models" row unless the catalog recommends nothing.
 */
export function modelSelectItems(
  models: readonly TuiModelChoice[],
  currentRef?: string,
): SearchableSelectItem[] {
  const recommends = models.some((model) => model.recommended);
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
      ...(recommends && !model.recommended && ref !== currentRef ? { collapsed: true } : {}),
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
