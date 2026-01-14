import { type SelectItem, SelectList, type SettingItem, SettingsList } from "@mariozechner/pi-tui";
import { selectListTheme, settingsListTheme } from "../theme/theme.js";

export function createSelectList(items: SelectItem[], maxVisible = 7) {
  return new SelectList(items, maxVisible, selectListTheme);
}

export function createSettingsList(
  items: SettingItem[],
  onChange: (id: string, value: string) => void,
  onCancel: () => void,
  maxVisible = 7,
) {
  return new SettingsList(items, maxVisible, settingsListTheme, onChange, onCancel);
}
