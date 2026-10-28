import { SettingsList } from "@earendil-works/pi-tui";
import { modelKey } from "../../agents/model-ref-shared.js";
import { searchableSelectListTheme, settingsListTheme } from "../theme/theme.js";
import type { TuiModelChoice } from "../tui-backend.js";
import type { TuiStateAccess } from "../tui-types.js";
import { SearchableSelectList, type SearchableSelectItem } from "./searchable-select-list.js";

export function createSearchableSelectList(items: SearchableSelectItem[], maxVisible = 7) {
  return new SearchableSelectList(items, maxVisible, searchableSelectListTheme);
}

// A name like "DeepSeek V4.1 Flash" only restates the id "deepseek-v4.1-flash".
const comparable = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

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
        model.name && comparable(model.name) !== comparable(model.id) ? model.name : "",
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

export function createTuiSettingsList(
  state: Pick<TuiStateAccess, "toolsExpanded" | "showThinking">,
  onChange: ConstructorParameters<typeof SettingsList>[3],
  onCancel: ConstructorParameters<typeof SettingsList>[4],
) {
  const items = [
    {
      id: "tools",
      label: "Tool output",
      currentValue: state.toolsExpanded ? "expanded" : "collapsed",
      values: ["collapsed", "expanded"],
    },
    {
      id: "thinking",
      label: "Show thinking",
      currentValue: state.showThinking ? "on" : "off",
      values: ["off", "on"],
    },
  ];
  return new SettingsList(items, 7, settingsListTheme, onChange, onCancel);
}
