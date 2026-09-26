import { type SettingItem, SettingsList } from "@earendil-works/pi-tui";
import { modelKey } from "../../agents/model-ref-shared.js";
import {
  filterableSelectListTheme,
  searchableSelectListTheme,
  settingsListTheme,
} from "../theme/theme.js";
import type { TuiModelChoice } from "../tui-backend.js";
import { FilterableSelectList, type FilterableSelectItem } from "./filterable-select-list.js";
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

export function createFilterableSelectList(items: FilterableSelectItem[], maxVisible = 7) {
  return new FilterableSelectList(items, maxVisible, filterableSelectListTheme);
}

export function createSettingsList(
  items: SettingItem[],
  onChange: (id: string, value: string) => void,
  onCancel: () => void,
  maxVisible = 7,
) {
  return new SettingsList(items, maxVisible, settingsListTheme, onChange, onCancel);
}
