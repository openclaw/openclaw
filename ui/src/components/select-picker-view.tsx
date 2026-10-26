import { For, Show, createMemo, createSignal, createStore, onSettled, untrack } from "solid-js";
import { acquireNativeOverlaySurface } from "../lib/native-overlay-occlusion.ts";
import { t } from "../lib/reactive/i18n.ts";
import { createAnchoredOverlay } from "../lib/reactive/overlay-anchor.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import { createScrollPosition, createScrollStateRef } from "../lib/reactive/scroll-state.ts";
import type { OverlayPlacement } from "./overlay-anchor.ts";
import { createOverlay } from "./overlay-lifecycle.ts";
import type { OverlayNativeAdapter } from "./overlay-types.ts";
import type { PickerOption, PickerParams, PickerGroup } from "./select-picker-types.ts";
import { Icon } from "./solid/icon.tsx";
import { useMenuMachine } from "./solid/menu-machine.ts";
import { MenuNavigationError } from "./solid/menu-navigation-error.tsx";
import { useOverlayControl } from "./solid/overlay-control.ts";
import "./solid/overlay.css";

type Section<Option> = { group?: PickerGroup; options: Option[]; expanded: boolean };
let nextId = 0;
const sheetAdapter: OverlayNativeAdapter = {
  isOpen: (surface) => !surface.hidden,
  show: (surface) => {
    surface.hidden = false;
  },
  hide: (surface) => {
    surface.hidden = true;
  },
};

export function PickerContent<Option extends PickerOption>(props: {
  params: PickerParams<Option>;
  host: HTMLElement;
}) {
  const id = `openclaw-picker-${++nextId}`;
  const contentId = `${id}-content`;
  const triggerId = () => props.params.id ?? `${id}-trigger`;
  let trigger!: HTMLButtonElement;
  let surface!: HTMLDivElement;
  let list!: HTMLDivElement;
  let input: HTMLInputElement | undefined;
  let back: HTMLButtonElement | undefined;
  const optionElements = new Map<string, HTMLDivElement>();
  const groupButtons = new Set<HTMLButtonElement>();
  const groupButtonRef = () => {
    let button!: HTMLButtonElement;
    onSettled(() => {
      groupButtons.add(button);
      return () => groupButtons.delete(button);
    });
    return (element: HTMLButtonElement) => (button = element);
  };
  const focusElements = () => [
    trigger,
    ...(back ? [back] : []),
    ...(input ? [input] : []),
    list,
    ...groupButtons,
    ...optionElements.values(),
  ];
  onSettled(() => {
    props.params.focusRef?.({ trigger, elements: focusElements });
  });
  let sheetScroll: { root: Element; top: number } | undefined;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverOpened = false;
  // A row the pointer highlights is already where the user is looking. Revealing
  // it would scroll a clipped edge row against an in-progress wheel or trackpad scroll.
  let pointerHighlight = false;
  const [searching, setSearching] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [keyboard, setKeyboard] = createSignal(false);
  const [collapsed, setCollapsed] = createStore<string[]>([]);
  const direction = () => (getComputedStyle(props.host).direction === "rtl" ? "rtl" : "ltr");
  const resolvePlacement = (
    placement: PickerParams<Option>["placement"],
    variant: PickerParams<Option>["variant"],
  ): OverlayPlacement =>
    variant === "submenu"
      ? direction() === "rtl"
        ? "left-start"
        : "right-start"
      : `${placement ?? "bottom"}-start`;
  const options = createMemo((): readonly Option[] => {
    const { value, options: configuredOptions } = props.params;
    if (
      value === null ||
      value === "" ||
      configuredOptions.some((option) => option.value === value)
    ) {
      return configuredOptions;
    }
    // SAFETY: Unknown selected references use only the base option fields, as before migration.
    return [...configuredOptions, { value, label: value } as Option];
  });
  const catalog = createMemo(
    () => options().map((option) => ({ option, group: props.params.groupBy?.(option) })),
    { lazy: true },
  );
  const searchText = createMemo(
    () =>
      catalog().map(({ option, group }) =>
        [option.label, option.value, option.description, group?.label]
          .join(" ")
          .toLocaleLowerCase(),
      ),
    { lazy: true },
  );
  const sections = createMemo(
    () => {
      const search = query().trim().toLocaleLowerCase();
      const terms = search ? search.split(/\s+/u) : [];
      const text = search ? searchText() : undefined;
      const ungrouped: Section<Option> = { options: [], expanded: true };
      const groups = new Map<string, Section<Option>>();
      for (const [index, { option, group }] of catalog().entries()) {
        if (text && !terms.every((term) => text[index]!.includes(term))) {
          continue;
        }
        if (!group) {
          ungrouped.options.push(option);
          continue;
        }
        let section = groups.get(group.id);
        if (!section) {
          section = {
            group,
            options: [],
            expanded: Boolean(search) || !collapsed.includes(group.id),
          };
          groups.set(group.id, section);
        }
        section.options.push(option);
      }
      return [ungrouped, ...groups.values()].map((section, position) =>
        Object.assign(section, { position }),
      );
    },
    { lazy: true },
  );
  const rows = createMemo(
    () => sections().flatMap((section) => (section.expanded ? section.options : [])),
    { lazy: true },
  );
  const selected = createMemo(() =>
    options().find((option) => option.value === props.params.value),
  );
  const visible = createMemo(() => new Set(rows().map((option) => option.value)), { lazy: true });
  const optionId = (value: string) => `${id}:${value}`;
  // Native presentation mode belongs to this mounted overlay lifetime.
  const initialSheet = untrack(() => props.params.sheet);
  const overlay = createOverlay(id, undefined, {
    native: initialSheet ? sheetAdapter : undefined,
    exclusiveGroup: "menu",
    isValid: () => !props.params.disabled,
    acquireOcclusion: acquireNativeOverlaySurface,
    onInitialFocus(intent) {
      const target = props.params.sheet && !keyboard() ? back : searching() ? input : list;
      if (
        intent === "last" &&
        !rows().some((option) => option.value === props.params.value && !option.disabled)
      ) {
        menu.setHighlightedValue(rows().findLast((option) => !option.disabled)?.value ?? null);
      }
      target?.focus({ preventScroll: true });
    },
    onEscape() {
      if (query() && props.params.searchable === "always") {
        setQuery("");
        return true;
      }
      return false;
    },
  });
  const opened = projectOwner(overlay, (owner) => owner.open, Object.is).read;
  const control = useOverlayControl(overlay, undefined, {
    get disabled() {
      return props.params.disabled;
    },
  });
  const anchor = createAnchoredOverlay(
    overlay,
    () => trigger,
    () => {
      const { placement, variant } = props.params;
      return { placement: () => resolvePlacement(placement, variant) };
    },
    { anchored: !initialSheet, paused: () => !overlay.open },
  );
  onSettled(() => overlay.bindSurface(surface));
  // The menu refreshes direction on accepted open; closed pickers need no style read.
  const menuDirection: typeof direction = () => (overlay.open ? direction() : "ltr");
  const menu = useMenuMachine(overlay, menuDirection, commit, undefined, {
    ids: { content: contentId, trigger: triggerId },
    surface: "listbox",
    focus: "retain",
    items: () => {
      opened();
      // Native opening asks for its initial highlight before Solid publishes open.
      return overlay.open ? rows() : [];
    },
    value: () => props.params.value,
  });
  const active = () => menu.highlightedValue();
  const controls = () =>
    opened() && props.params.groupBy
      ? sections()
          .map((_, index) => `${id}-group-${index}`)
          .join(" ")
      : id;
  function commit(value: string) {
    const option = rows().find((row) => row.value === value);
    if (!overlay.open || props.params.disabled || !option || option.disabled) {
      return;
    }
    overlay.request(false, "return");
    if (props.params.onChangeTarget) {
      props.params.onChangeTarget(value, props.host);
    } else {
      props.params.onChange(value);
    }
  }
  function open(last = false, focus = true, initialKey?: string) {
    if (props.params.disabled || overlay.open) {
      return;
    }
    setSearching(
      props.params.searchable === "always" ||
        Boolean(props.params.searchable && (props.params.groupBy || options().length > 8)),
    );
    queueMicrotask(() => {
      if (!props.host.isConnected) {
        return;
      }
      if (!initialSheet) {
        anchor.update(trigger, resolvePlacement(props.params.placement, props.params.variant));
      }
      if (!overlay.request(true, focus ? (last ? "last" : "first") : "none")) {
        return;
      }
      if (initialKey) {
        queueMicrotask(() => {
          if (searching()) {
            setQuery(initialKey);
          } else {
            menu.typeahead(initialKey);
          }
        });
      }
    });
  }

  function scrollFade() {
    if (!overlay.open) {
      return;
    }
    list.toggleAttribute("data-fade-start", list.scrollTop > 0);
    list.toggleAttribute(
      "data-fade-end",
      list.scrollTop + list.clientHeight < list.scrollHeight - 1,
    );
  }
  const scrollRef = createScrollStateRef(scrollFade, {
    presented: opened,
    content: () => (opened() ? rows() : undefined),
  });
  function handleKeydown(event: KeyboardEvent) {
    if (event.isComposing || props.params.disabled) {
      return;
    }
    pointerHighlight = false;
    const editing = event.target instanceof HTMLInputElement;
    if (!editing || event.key.startsWith("Arrow")) {
      setKeyboard(true);
    }
    const forward =
      props.params.variant === "submenu" && direction() === "rtl" ? "ArrowLeft" : "ArrowRight";
    if (!overlay.open) {
      const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (
        ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key) ||
        (props.params.variant === "submenu" && event.key === forward) ||
        printable
      ) {
        event.preventDefault();
        event.stopPropagation();
        open(event.key === "ArrowUp", true, printable && event.key !== " " ? event.key : undefined);
      }
      return;
    }
    if (event.key === "Escape") {
      overlay.keydown(event);
      return;
    }
    if (event.key === "Tab" && !props.params.groupBy) {
      overlay.request(false, "return");
      return;
    }
    if (
      props.params.variant === "submenu" &&
      !editing &&
      event.key === (forward === "ArrowLeft" ? "ArrowRight" : "ArrowLeft")
    ) {
      event.preventDefault();
      event.stopPropagation();
      overlay.request(false, "return");
      return;
    }
    if (
      event.target instanceof Element &&
      event.target.closest(".picker-select__back, .picker-select__group-toggle")
    ) {
      return;
    }
    if (event.key !== "Escape") {
      event.stopPropagation();
    }
    menu.keydown(event);
  }
  function hover(event: PointerEvent) {
    if (props.params.variant !== "submenu" || props.params.sheet || event.pointerType !== "mouse") {
      return;
    }
    clearTimeout(hoverTimer);
    const enter = event.type === "pointerenter";
    if (enter === overlay.open) {
      return;
    }
    hoverTimer = setTimeout(
      () => {
        if (enter) {
          setKeyboard(false);
          hoverOpened = true;
          open(false, false);
        } else {
          overlay.request(false, overlay.containsFocus() ? "return" : "none");
        }
      },
      enter ? 120 : 150,
    );
  }
  createScrollPosition(
    () => ({
      reveal: opened()
        ? {
            identity: [opened(), active(), query(), rows()],
            target: () =>
              overlay.open && !pointerHighlight
                ? optionElements.get(menu.highlightedValueNow() ?? "")
                : undefined,
          }
        : undefined,
    }),
    { region: () => list, revealTiming: "animation-frame" },
  );
  function onOpenChange(next: boolean) {
    if (next) {
      pointerHighlight = false;
      props.params.onOpen?.();
      const root = surface.offsetParent;
      if (props.params.sheet && root) {
        sheetScroll = { root, top: root.scrollTop };
        root.scrollTop = 0;
      }
    } else {
      setQuery("");
      setSearching(false);
      setCollapsed((draft) => {
        draft.length = 0;
      });
      hoverOpened = false;
      if (sheetScroll) {
        sheetScroll.root.scrollTop = sheetScroll.top;
        sheetScroll = undefined;
      }
    }
  }
  onSettled(() => {
    const disconnectAnchor = anchor.connect();
    const stop = control.connect(() => {}, onOpenChange);
    return () => {
      clearTimeout(hoverTimer);
      stop();
      disconnectAnchor();
    };
  });
  const Leading = (row: { option?: Option }) => {
    const content = createMemo(() => row.option && props.params.renderLeading?.(row.option));
    return (
      <Show when={content() !== undefined && content() !== null}>
        <span class="picker-select__leading">{content()}</span>
      </Show>
    );
  };
  const OptionRow = (row: { option: () => Option; grouped: boolean }) => {
    const itemRef = menu.itemRef();
    let element: HTMLDivElement;
    onSettled(() => {
      // The parent For keeps this registration's value for the row's lifetime.
      const value = row.option().value;
      optionElements.set(value, element);
      return () => {
        if (optionElements.get(value) === element) {
          optionElements.delete(value);
        }
      };
    });
    return (
      <div
        ref={[itemRef, (node) => (element = node)]}
        {...menu.item(
          row.option().value,
          row.option().disabled || !visible().has(row.option().value),
          undefined,
          false,
          row.option().label,
        )}
        class="picker-select__option"
        role="option"
        id={optionId(row.option().value)}
        data-value={row.option().value}
        hidden={!visible().has(row.option().value)}
        title={props.params.showOptionTooltips === false ? undefined : row.option().value}
        aria-selected={row.option().value === props.params.value ? "true" : "false"}
        aria-disabled={row.option().disabled ? "true" : "false"}
        data-active={row.option().value === active() ? "" : undefined}
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => {
          setKeyboard(false);
          pointerHighlight = true;
          if (!row.option().disabled) {
            menu.setHighlightedValue(row.option().value);
          }
        }}
        onClick={() => commit(row.option().value)}
      >
        {!row.grouped && <Leading option={row.option()} />}
        <span class="picker-select__copy">
          <span class="picker-select__label" style={row.option().labelStyle}>
            {row.option().label}
          </span>
          <Show when={row.option().description}>
            <span class="picker-select__description">{row.option().description}</span>
          </Show>
        </span>
        <span class="picker-select__check" aria-hidden="true">
          <Show when={row.option().value === props.params.value}>
            <Icon name="check" />
          </Show>
        </span>
      </div>
    );
  };
  return (
    <div onPointerEnter={hover} onPointerLeave={hover} data-keyboard={keyboard() ? "" : undefined}>
      <button
        ref={(element) => (trigger = element)}
        onKeyDown={handleKeydown}
        data-menu-trigger={id}
        id={triggerId()}
        class="picker-select__trigger"
        type="button"
        aria-label={
          selected()
            ? `${props.params.label}: ${[selected()?.label, props.params.showSelectedDescription && selected()?.description].filter(Boolean).join(" · ")}`
            : props.params.label
        }
        aria-haspopup="listbox"
        aria-expanded={opened() ? "true" : "false"}
        aria-controls={controls()}
        aria-invalid={props.params.invalid ? "true" : undefined}
        aria-describedby={props.params.describedBy}
        title={props.params.title}
        disabled={props.params.disabled}
        onClick={() => {
          clearTimeout(hoverTimer);
          setKeyboard(false);
          if (!overlay.open) {
            open();
          } else if (hoverOpened) {
            hoverOpened = false;
          } else {
            overlay.request(false);
          }
        }}
      >
        <Show when={props.params.variant === "submenu"}>
          <span class="picker-select__name">{props.params.label}</span>
        </Show>
        <Leading option={selected()} />
        <span class="picker-select__copy">
          <span class="picker-select__label">{selected()?.label ?? props.params.label}</span>
          <Show when={props.params.showSelectedDescription && selected()?.description}>
            <span class="picker-select__description">{selected()?.description}</span>
          </Show>
        </span>
        <span class="picker-select__chevron" aria-hidden="true">
          <Icon
            name={
              props.params.variant === "submenu" || props.params.sheet
                ? "chevronRight"
                : "chevronDown"
            }
          />
        </span>
      </button>
      <div
        {...menu.content()}
        onKeyDown={handleKeydown}
        role={undefined}
        aria-label={undefined}
        aria-labelledby={undefined}
        ref={(element) => (surface = element)}
        id={contentId}
        class={[
          "picker-select__menu",
          {
            "oc-overlay": !props.params.sheet,
            "picker-select__menu--grouped": Boolean(props.params.groupBy),
          },
        ]}
        popover={props.params.sheet ? undefined : "manual"}
        hidden={props.params.sheet ? true : undefined}
      >
        <MenuNavigationError binding={menu} />
        <Show when={props.params.sheet}>
          <div class="picker-select__page-header">
            <button
              type="button"
              ref={(element) => (back = element)}
              class="picker-select__back"
              aria-label={t("common.back")}
              onClick={() => overlay.request(false, "return")}
            >
              <Icon name="chevronLeft" />
            </button>
            <span>{props.params.label}</span>
          </div>
        </Show>
        <Show when={searching()}>
          <input
            ref={(element) => (input = element)}
            class="picker-select__search settings-input"
            type="search"
            role="combobox"
            data-picker-focus
            data-search
            tabindex="0"
            autocomplete="off"
            spellcheck="false"
            aria-label={t("common.search")}
            placeholder={props.params.searchPlaceholder ?? t("common.search")}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={controls()}
            aria-invalid={props.params.invalid ? "true" : undefined}
            aria-describedby={props.params.describedBy}
            aria-activedescendant={active() !== null ? optionId(active()!) : undefined}
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
        </Show>
        <div
          ref={[(element) => (list = element), scrollRef]}
          class="picker-select__options"
          role={props.params.groupBy ? undefined : "listbox"}
          id={props.params.groupBy ? undefined : id}
          aria-label={props.params.groupBy ? undefined : props.params.label}
          data-picker-focus={!searching() ? "" : undefined}
          tabindex={searching() ? -1 : 0}
          aria-activedescendant={
            opened() && !searching() && active() !== null ? optionId(active()!) : undefined
          }
        >
          <For each={opened() ? sections() : []} keyed={(section) => section.position}>
            {(section, index) => (
              <Show
                when={section().group}
                fallback={
                  <div
                    id={props.params.groupBy ? `${id}-group-${index()}` : undefined}
                    role={props.params.groupBy ? "listbox" : undefined}
                    aria-label={props.params.groupBy ? props.params.label : undefined}
                  >
                    <For
                      each={props.params.groupBy ? section().options : options()}
                      keyed={(option) => option.value}
                    >
                      {(option) => <OptionRow option={option} grouped={false} />}
                    </For>
                  </div>
                }
              >
                {(group) => (
                  <div class="picker-select__group" role="group" aria-label={group().label}>
                    <button
                      ref={groupButtonRef()}
                      class="picker-select__group-toggle"
                      type="button"
                      tabindex={opened() ? 0 : -1}
                      aria-expanded={section().expanded ? "true" : "false"}
                      aria-controls={`${id}-group-${index()}`}
                      disabled={Boolean(query().trim())}
                      onClick={() =>
                        setCollapsed((draft) => {
                          const collapsedIndex = draft.indexOf(group().id);
                          if (collapsedIndex !== -1) {
                            draft.splice(collapsedIndex, 1);
                          } else {
                            draft.push(group().id);
                          }
                        })
                      }
                    >
                      {group().leading}
                      <span class="picker-select__group-label">{group().label}</span>
                      <span>{section().options.length}</span>
                      <span class="picker-select__chevron" aria-hidden="true">
                        <Icon name="chevronDown" />
                      </span>
                    </button>
                    <div
                      id={`${id}-group-${index()}`}
                      class="picker-select__group-options"
                      role="listbox"
                      aria-label={group().label}
                    >
                      <Show when={section().expanded}>
                        <For each={section().options} keyed={(option) => option.value}>
                          {(option) => <OptionRow option={option} grouped />}
                        </For>
                      </Show>
                    </div>
                  </div>
                )}
              </Show>
            )}
          </For>
        </div>
        <div
          class="picker-select__empty"
          role="status"
          hidden={!opened() || sections().some((section) => section.options.length > 0)}
        >
          {t("common.pickerNoMatches")}
        </div>
      </div>
    </div>
  );
}
