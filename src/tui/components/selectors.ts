// Selector components adapt Pi TUI list controls for OpenClaw settings.
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

/** Creates a themed searchable select list for TUI overlays. */
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

/** Creates a themed filterable select list for TUI overlays. */
export function createFilterableSelectList(items: FilterableSelectItem[], maxVisible = 7) {
  return new FilterableSelectList(items, maxVisible, filterableSelectListTheme);
}

/** Creates a themed settings list with change and cancel callbacks. */
export function createSettingsList(
  items: SettingItem[],
  onChange: (id: string, value: string) => void,
  onCancel: () => void,
  maxVisible = 7,
) {
  return new SettingsList(items, maxVisible, settingsListTheme, onChange, onCancel);
}
