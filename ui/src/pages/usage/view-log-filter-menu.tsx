import { createMemo, createProjection } from "solid-js";
import { Menu, type MenuItem } from "../../components/solid/menu.tsx";
import { t } from "../../lib/reactive/i18n.ts";

/** Phone form of a conversation filter: the checkbox menu the page's facet filters use. */
export function UsageLogFilterMenu(props: {
  id: string;
  label: string;
  options: readonly { value: string; label: string }[];
  selected: readonly string[];
  onChange: (values: string[]) => void;
}) {
  const selectedSet = createMemo(() => new Set(props.selected));
  const items = createProjection<MenuItem[]>(
    () => [
      {
        id: "command:select-all",
        label: t("usage.filters.selectAll"),
        disabled: props.options.every(({ value }) => selectedSet().has(value)),
        closeOnSelect: false,
      },
      {
        id: "command:clear",
        label: t("usage.filters.clear"),
        disabled: props.selected.length === 0,
        closeOnSelect: false,
      },
      ...props.options.map(({ value, label }): MenuItem => ({
        id: `option:${encodeURIComponent(value)}`,
        label,
        class: "usage-filter-option",
        type: "checkbox",
        checked: selectedSet().has(value),
        closeOnSelect: false,
      })),
    ],
    [],
    { key: "id" },
  );
  return (
    <Menu
      id={props.id}
      lazy
      label={`${props.label} ${props.selected.length > 0 ? props.selected.length : t("usage.filters.all")}`}
      class="usage-filter-select"
      triggerClass="usage-filter-trigger"
      placement="bottom-start"
      items={items}
      onSelect={(item) => {
        if (item.id === "command:select-all") {
          props.onChange(props.options.map(({ value }) => value));
        } else if (item.id === "command:clear") {
          props.onChange([]);
        } else if (item.id.startsWith("option:")) {
          const value = decodeURIComponent(item.id.slice("option:".length));
          props.onChange(
            selectedSet().has(value)
              ? props.selected.filter((entry) => entry !== value)
              : [...props.selected, value],
          );
        }
      }}
      trigger={
        <>
          <span class="usage-filter-trigger__label">{props.label}</span>
          <span class="settings-count">
            {props.selected.length > 0 ? props.selected.length : t("usage.filters.all")}
          </span>
        </>
      }
    />
  );
}
