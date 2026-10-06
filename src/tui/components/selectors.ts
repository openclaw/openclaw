import { modelKey } from "../../agents/model-ref-shared.js";
import { searchableSelectListTheme } from "../theme/theme.js";
import type { TuiModelChoice } from "../tui-backend.js";
import { SearchableSelectList, type SearchableSelectItem } from "./searchable-select-list.js";

export function createSearchableSelectList(items: SearchableSelectItem[], maxVisible = 7) {
  return new SearchableSelectList(items, maxVisible, searchableSelectListTheme);
}

export function modelSelectItems(models: readonly TuiModelChoice[]): SearchableSelectItem[] {
  return models.map((model) => {
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
    };
  });
}
