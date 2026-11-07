import type { JSX } from "@solidjs/web";
import { Show, createMemo, createSignal } from "solid-js";
import type { OverlayPlacement } from "../../components/overlay-anchor.ts";
import { Icon } from "../../components/solid/icon.tsx";
import {
  Menu,
  createMenuControls,
  type MenuControls,
  type MenuEntry,
  type MenuItem,
} from "../../components/solid/menu.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";

export type UsageValueOption = {
  value: string;
  label: string;
  /** Sessions in range that carry this value; absent when the Gateway doesn't report it. */
  count?: number;
  /** Pinned above the ranked list whether or not it is selected, like "You". */
  pinned?: boolean;
  leading?: JSX.Element;
  secondary?: string;
};

export type UsageValuePickerConfig = {
  /** Unique within one menu tree; prefixes every row id. */
  id: string;
  options: () => readonly UsageValueOption[];
  isSelected: (value: string) => boolean;
  multiple: boolean;
  searchLabel: () => string;
  onToggle: (value: string) => void;
  onClear: () => void;
  /** Multi-value fields keep "Select all"; it selects every row the search shows. */
  onSelectAll?: (values: string[]) => void;
  controls?: MenuControls;
};

const normalize = (value: string) => value.toLocaleLowerCase().normalize("NFC");

/**
 * One searchable value list: search on top, pinned and selected values first, the rest by
 * session count. The rows are plain menu rows, so arrows, Enter and Escape behave like every
 * other menu; Enter in the search toggles the first match.
 */
export function createUsageValuePicker(config: UsageValuePickerConfig) {
  const controls = config.controls ?? createMenuControls();
  const [query, setQuery] = createSignal("");
  // Pinned rows are fixed when the list opens, so checking a value never moves rows under the pointer.
  const [pinnedAtOpen, setPinnedAtOpen] = createSignal<ReadonlySet<string>>(new Set());
  const reset = () => {
    setQuery("");
    setPinnedAtOpen(
      new Set(
        config
          .options()
          .filter((option) => option.pinned || config.isSelected(option.value))
          .map((option) => option.value),
      ),
    );
  };
  const rowId = (value: string) => `${config.id}:value:${encodeURIComponent(value)}`;
  const rows = createMemo(() => {
    const terms = normalize(query().trim()).split(/\s+/u).filter(Boolean);
    const pinnedSet = pinnedAtOpen();
    const matches = config
      .options()
      .filter((option) =>
        terms.every((term) =>
          normalize([option.label, option.value, option.secondary ?? ""].join(" ")).includes(term),
        ),
      );
    const byCount = (a: UsageValueOption, b: UsageValueOption) =>
      (b.count ?? 0) - (a.count ?? 0) || a.label.localeCompare(b.label);
    const pinned = matches
      .filter((option) => pinnedSet.has(option.value) || option.pinned)
      .toSorted((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || byCount(a, b));
    const rest = matches
      .filter((option) => !pinnedSet.has(option.value) && !option.pinned)
      .toSorted(byCount);
    return { pinned, rest, all: [...pinned, ...rest] };
  });
  const selectedCount = () =>
    config.options().filter((option) => config.isSelected(option.value)).length;
  const searchKeydown = nativeListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || !query().trim()) {
      return;
    }
    const first = rows().all[0];
    if (!first) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    config.onToggle(first.value);
  });
  const searchEntry: MenuEntry = {
    kind: "content",
    id: `${config.id}:search`,
    content: (
      <div class="usage-value-picker__search">
        <Icon name="search" />
        <input
          ref={[controls.ref(), searchKeydown]}
          type="text"
          data-search=""
          data-form-control=""
          data-initial-focus=""
          autocomplete="off"
          spellcheck={false}
          aria-label={config.searchLabel()}
          placeholder={config.searchLabel()}
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <Show
          when={selectedCount() > 0}
          fallback={
            <Show when={config.onSelectAll && rows().all.length > 0}>
              <button
                ref={controls.ref()}
                type="button"
                class="usage-value-picker__action"
                data-form-control=""
                onClick={() => config.onSelectAll?.(rows().all.map((option) => option.value))}
              >
                {t("usage.filters.selectAll")}
              </button>
            </Show>
          }
        >
          <button
            ref={controls.ref()}
            type="button"
            class="usage-value-picker__action"
            data-form-control=""
            onClick={() => config.onClear()}
          >
            {t("usage.filters.clear")}
          </button>
        </Show>
      </div>
    ),
  };
  const item = (option: UsageValueOption): MenuItem => ({
    id: rowId(option.value),
    label: option.secondary ? `${option.label}, ${option.secondary}` : option.label,
    type: config.multiple ? "checkbox" : "radio",
    checked: config.isSelected(option.value),
    closeOnSelect: !config.multiple,
    class: "usage-value-picker__option",
    icon: option.leading,
    content: (
      <span class="usage-value-picker__label">
        <span class="usage-value-picker__name">{option.label}</span>
        {option.secondary ? (
          <span class="usage-value-picker__secondary">{option.secondary}</span>
        ) : undefined}
      </span>
    ),
    details:
      option.count === undefined ? undefined : (
        <span class="usage-value-picker__count">{option.count.toLocaleString()}</span>
      ),
  });
  const entries = createMemo((): MenuEntry[] => {
    const { pinned, rest, all } = rows();
    const list: MenuEntry[] =
      all.length === 0
        ? [
            {
              kind: "content",
              id: `${config.id}:empty`,
              content: (
                <div class="usage-value-picker__empty" role="status">
                  {t("usage.filters.noMatches", { query: query().trim() })}
                </div>
              ),
            },
          ]
        : [
            ...pinned.map(item),
            ...(pinned.length && rest.length
              ? [
                  {
                    kind: "content" as const,
                    id: `${config.id}:pinned-end`,
                    content: <div role="separator" />,
                  },
                ]
              : []),
            ...rest.map(item),
          ];
    return [
      searchEntry,
      { kind: "group", id: `${config.id}:list`, class: "usage-value-picker__list", items: list },
    ];
  });
  /** Handles a selected row from this picker; returns false for rows it doesn't own. */
  const select = (selected: MenuItem) => {
    const prefix = `${config.id}:value:`;
    if (!selected.id.startsWith(prefix)) {
      return false;
    }
    config.onToggle(decodeURIComponent(selected.id.slice(prefix.length)));
    return true;
  };
  return { entries, select, reset, controls };
}

/** A field's own picker menu, opened from a trigger that stays where the field lives. */
export function UsageValuePicker(
  props: Omit<UsageValuePickerConfig, "controls"> & {
    label: string;
    trigger: JSX.Element;
    triggerClass?: JSX.ClassValue;
    class?: string;
    placement?: OverlayPlacement;
    ref?: (open: () => void) => void;
  },
) {
  const picker = createUsageValuePicker(props);
  return (
    <Menu
      id={`usage-value-picker-${props.id}`}
      lazy
      label={props.label}
      class={props.class}
      panelClass="usage-value-picker"
      triggerClass={props.triggerClass}
      placement={props.placement ?? "bottom-start"}
      controls={picker.controls}
      items={picker.entries()}
      onBeforeShow={picker.reset}
      onSelect={(item) => void picker.select(item)}
      ref={(handle) => props.ref?.(() => handle.open())}
      trigger={props.trigger}
    />
  );
}
