import { SettingsList } from "@mariozechner/pi-tui";
import { filterableSelectListTheme, searchableSelectListTheme, settingsListTheme, } from "../theme/theme.js";
import { FilterableSelectList } from "./filterable-select-list.js";
import { SearchableSelectList } from "./searchable-select-list.js";
export function createSearchableSelectList(items, maxVisible = 7) {
    return new SearchableSelectList(items, maxVisible, searchableSelectListTheme);
}
export function createFilterableSelectList(items, maxVisible = 7) {
    return new FilterableSelectList(items, maxVisible, filterableSelectListTheme);
}
export function createSettingsList(items, onChange, onCancel, maxVisible = 7) {
    return new SettingsList(items, maxVisible, settingsListTheme, onChange, onCancel);
}
