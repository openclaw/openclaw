import { normalizeCsvOrLooseStringList } from "@openclaw/normalization-core/string-normalization";
import { For, Show, createMemo, createSignal, merge, onSettled } from "solid-js";
import { acquireNativeOverlaySurface } from "../lib/native-overlay-occlusion.ts";
import { t } from "../lib/reactive/i18n.ts";
import type { ModelPickerOption } from "./model-picker-options.ts";
import { createOverlayAnchor } from "./overlay-anchor.ts";
import { createOverlay, findOverlayParent } from "./overlay-lifecycle.ts";
import { Icon } from "./solid/icon.tsx";
import { useMenuMachine } from "./solid/menu-machine.ts";
import { MenuNavigationError } from "./solid/menu-navigation-error.tsx";
import { useOverlayControl } from "./solid/overlay-control.ts";
import { ProviderBrandIcon } from "./solid/provider-icon.tsx";
import "./solid/overlay.css";
import "../styles/multi-select.css";

type MultiSelectProps = {
  options: readonly ModelPickerOption[];
  /** Current values in display order. Controlled: the host owns them. */
  value: readonly string[];
  isExcluded: (value: string) => boolean;
  /** The caller owns value identity; search remains case-insensitive. */
  getValueKey: (value: string) => string;
  placeholder: string;
  accessibleLabel: string;
  allowCustom: boolean;
  disabled: boolean;
  onChange: (value: string[]) => void;
  onOpen: () => void;
};

type MultiSelectRow = ModelPickerOption & { custom?: boolean };
let instanceCounter = 0;

function providerFromValue(value: string): string | undefined {
  const separator = value.indexOf("/");
  return separator > 0 ? value.slice(0, separator) : undefined;
}

export function MultiSelect(initial: Partial<MultiSelectProps> & { class?: string }) {
  const defaults: MultiSelectProps = {
    options: [],
    value: [],
    isExcluded: () => false,
    getValueKey: (value: string) => value,
    placeholder: "",
    accessibleLabel: "",
    allowCustom: false,
    disabled: false,
    onChange: (_value: string[]) => {},
    onOpen: () => {},
  };
  const props = merge(defaults, initial);
  const id = `openclaw-multi-select-${++instanceCounter}`;
  let field!: HTMLDivElement;
  let input!: HTMLInputElement;
  let surface!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const label = () => props.accessibleLabel || props.placeholder;
  const optionFor = (value: string) =>
    props.options.find((option) => props.getValueKey(option.value) === props.getValueKey(value));
  const rows = createMemo<MultiSelectRow[]>(() => {
    if (!open()) {
      return [];
    }
    const taken = new Set(props.value.map((value) => props.getValueKey(value)));
    const custom = query().trim();
    const customKey = props.getValueKey(custom);
    const search = custom.toLowerCase().normalize("NFC");
    const result: MultiSelectRow[] = [];
    let exact: MultiSelectRow | undefined;
    for (const option of props.options) {
      const key = props.getValueKey(option.value);
      if (taken.has(key) || props.isExcluded(option.value)) {
        continue;
      }
      if (key === customKey) {
        exact = option;
      } else if (
        !search ||
        [option.label, option.value, option.provider, option.description].some((text) =>
          text?.toLowerCase().normalize("NFC").includes(search),
        )
      ) {
        result.push(option);
      }
    }
    if (exact) {
      result.unshift(exact);
    } else if (props.allowCustom && custom && !taken.has(customKey) && !props.isExcluded(custom)) {
      result.push({
        value: custom,
        label: custom,
        provider: providerFromValue(custom),
        custom: true,
      });
    }
    return result;
  });
  const overlay = createOverlay(id, undefined, {
    acquireOcclusion: acquireNativeOverlaySurface,
    isValid: () => !props.disabled,
    interactionElements: () => [field],
  });
  const commit = (values: readonly string[]) => {
    if (props.disabled) {
      return;
    }
    const taken = new Set(props.value.map((value) => props.getValueKey(value)));
    const additions: string[] = [];
    for (const value of values) {
      const next = value.trim();
      const key = props.getValueKey(next);
      if (next && !taken.has(key) && !props.isExcluded(next) && !optionFor(next)?.disabled) {
        taken.add(key);
        additions.push(next);
      }
    }
    if (additions.length) {
      props.onChange([...props.value, ...additions]);
    }
    setQuery("");
    menu.setHighlightedValue(null);
  };
  const select = (value: string) => {
    const row = rows().find((item) => item.value === value);
    if (row && !row.disabled) {
      commit(row.custom ? normalizeCsvOrLooseStringList(query()) : [row.value]);
    }
  };
  const menu = useMenuMachine(
    overlay,
    () => (document.dir === "rtl" ? "rtl" : "ltr"),
    select,
    undefined,
    {
      focus: "retain",
      surface: "listbox",
      items: rows,
      ids: { content: `${id}-content`, trigger: `${id}-trigger` },
    },
  );
  const activeId = () => {
    const value = menu.highlightedValue();
    return value ? menu.itemId(value) : undefined;
  };
  const openMenu = () => {
    if (!props.disabled && !overlay.open) {
      overlay.request(true);
    }
  };
  const removeAt = (index: number) => {
    if (!props.disabled) {
      props.onChange(props.value.filter((_, i) => i !== index));
      input.focus();
    }
  };
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      props.onOpen();
    } else {
      setQuery("");
    }
  };
  const control = useOverlayControl(overlay, undefined, {
    get disabled() {
      return props.disabled;
    },
    onOpenChange: handleOpenChange,
  });
  onSettled(() => {
    overlay.bindSurface(surface);
    overlay.bindTrigger(input);
    overlay.setParent(findOverlayParent(field));
    const anchor = createOverlayAnchor(surface);
    anchor.update(field);
    const disconnectControl = control.connect(() => {});
    return () => {
      disconnectControl();
      anchor.dispose();
    };
  });
  const handleKeydown = (event: KeyboardEvent) => {
    if (props.disabled || event.isComposing) {
      return;
    }
    if (event.key === "," && props.allowCustom) {
      event.preventDefault();
      commit(normalizeCsvOrLooseStringList(query()));
    } else if (event.key === "Backspace" && !query() && props.value.length) {
      event.preventDefault();
      removeAt(props.value.length - 1);
    } else if (!overlay.open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      openMenu();
    } else {
      // The shared menu machine owns navigation while the text input keeps focus.
      menu.keydown(event);
    }
  };
  return (
    <openclaw-multi-select class={props.class}>
      <div
        ref={(node) => (field = node)}
        class={["multi-select", { "multi-select--open": open() }]}
        data-disabled={props.disabled ? "" : undefined}
        onClick={(event) => {
          if (
            !props.disabled &&
            !(event.target instanceof Element && event.target.closest("button"))
          ) {
            input.focus();
            openMenu();
          }
        }}
      >
        <For each={props.value}>
          {(value, index) => {
            const option = () => optionFor(value);
            const provider = () => option()?.provider ?? providerFromValue(value);
            const chipLabel = () => option()?.label ?? value;
            return (
              <span class="chip multi-select__chip" data-value={value} title={value}>
                <Show when={provider()}>
                  {(name) => (
                    <ProviderBrandIcon provider={name()} class="multi-select__chip-icon" />
                  )}
                </Show>
                <span class="multi-select__chip-label">{chipLabel()}</span>
                <button
                  type="button"
                  class="chip-remove"
                  aria-label={t("common.multiSelect.remove", { value: chipLabel() })}
                  disabled={props.disabled}
                  onClick={() => removeAt(index())}
                >
                  <Icon name="x" />
                </button>
              </span>
            );
          }}
        </For>
        <input
          ref={(node) => (input = node)}
          id={`${id}-trigger`}
          data-menu-trigger={id}
          class="multi-select__input"
          type="text"
          role="combobox"
          autocomplete="off"
          spellcheck="false"
          aria-label={label()}
          aria-expanded={open() ? "true" : "false"}
          aria-controls={`${id}-content`}
          aria-autocomplete="list"
          aria-activedescendant={activeId()}
          placeholder={props.value.length === 0 ? props.placeholder : ""}
          value={query()}
          disabled={props.disabled}
          onInput={(event) => {
            menu.setHighlightedValue(null);
            setQuery(event.currentTarget.value);
            openMenu();
          }}
          onKeyDown={handleKeydown}
        />
        <span class="multi-select__chevron" aria-hidden="true">
          <Icon name="chevronDown" />
        </span>
      </div>
      <div
        {...menu.content()}
        ref={(node) => (surface = node)}
        class="multi-select__popup multi-select__menu oc-overlay"
        popover="manual"
        role="listbox"
        id={`${id}-content`}
        aria-label={label()}
      >
        <MenuNavigationError binding={menu} />
        <For each={rows()}>
          {(row) => {
            const itemRef = menu.itemRef();
            return (
              <div
                {...menu.item(row.value, row.disabled)}
                ref={itemRef}
                class="multi-select__option"
                role="option"
                aria-selected={menu.highlightedValue() === row.value ? "true" : "false"}
                aria-disabled={row.disabled ? "true" : "false"}
                data-value={row.value}
                data-custom={row.custom ? "" : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => select(row.value)}
              >
                <Show when={row.provider}>
                  {(provider) => (
                    <ProviderBrandIcon provider={provider()} class="multi-select__option-icon" />
                  )}
                </Show>
                <span class="picker-select__copy">
                  <span class="picker-select__label">
                    {row.custom
                      ? t("common.multiSelect.addCustom", { value: row.value })
                      : row.label}
                  </span>
                  <Show when={row.description}>
                    <span class="picker-select__description">{row.description}</span>
                  </Show>
                </span>
              </div>
            );
          }}
        </For>
        <Show when={rows().length === 0}>
          <div class="multi-select__empty">{t("common.multiSelect.noMatches")}</div>
        </Show>
      </div>
    </openclaw-multi-select>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-multi-select": HTMLAttributes<HTMLElement>;
    }
  }
}
