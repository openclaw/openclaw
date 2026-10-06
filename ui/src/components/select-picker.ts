import WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { configureAnchoredPopup } from "./anchored-overlay.ts";
import { icons } from "./icons.ts";
import { revealInScrollRegion } from "./scroll-state.ts";
import "../styles/select-picker.css";

export type PickerOption = {
  value: string;
  label: string;
  description?: string;
  labelStyle?: string;
  disabled?: boolean;
};

type PickerGroup = { id: string; label: string; leading?: unknown };
type PickerSection<Option> = { group?: PickerGroup; options: Option[]; expanded: boolean };

export type PickerParams<Option extends PickerOption> = {
  id?: string;
  label: string;
  value: string | null;
  options: readonly Option[];
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
  title?: string;
  placement?: "top" | "bottom";
  variant?: "submenu";
  /** Show the choices as a page of the enclosing sheet instead of a floating popup. */
  sheet?: boolean;
  /** `true` searches long lists; `"always"` keeps the field for short lists too. */
  searchable?: boolean | "always";
  searchPlaceholder?: string;
  groupBy?: (option: Option) => PickerGroup | undefined;
  showOptionTooltips?: boolean;
  showSelectedDescription?: boolean;
  onOpen?: () => void;
  onChange: (value: string) => void;
  onChangeTarget?: (value: string, select: HTMLElement) => void;
  renderLeading?: (option: Option) => unknown;
};

let pickerCount = 0;

function nextPickerId() {
  pickerCount += 1;
  return `openclaw-picker-${pickerCount}`;
}

export class SelectPicker<
  Option extends PickerOption = PickerOption,
> extends OpenClawLightDomElement {
  @property({ attribute: false }) params!: PickerParams<Option>;
  @state() private mode: "closed" | "compact" | "search" = "closed";
  @state() private query = "";
  @state() private activeValue: string | null = null;
  /** Keyboard use since the last pointer use; styles may reserve focus rings for it. */
  @state() private keyboard = false;

  @state() private collapsedGroups = new Set<string>();

  private readonly listboxId = nextPickerId();
  private typeahead = "";
  private typeaheadAt = 0;
  private renderedSections: PickerSection<Option>[] = [];
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  /** The sheet a page covers, and the scroll position to restore on Back. */
  private sheetScroll: { root: Element; top: number } | null = null;
  private hoverOpened = false;

  private options(): readonly Option[] {
    const { value, options } = this.params;
    return value === null || value === "" || options.some((option) => option.value === value)
      ? options
      : [...options, { value, label: value } as Option];
  }

  private sections(): PickerSection<Option>[] {
    const terms = this.query.trim().toLocaleLowerCase().split(/\s+/u);
    const ungrouped: PickerSection<Option> = { options: [], expanded: true };
    const groups = new Map<string, PickerSection<Option>>();
    for (const option of this.options()) {
      const group = this.params.groupBy?.(option);
      const text = [option.label, option.value, option.description, group?.label]
        .join(" ")
        .toLocaleLowerCase();
      if (!terms.every((term) => text.includes(term))) {
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
          expanded: Boolean(this.query.trim()) || !this.collapsedGroups.has(group.id),
        };
        groups.set(group.id, section);
      }
      section.options.push(option);
    }
    return [ungrouped, ...groups.values()];
  }

  private rows(sections = this.sections()): readonly Option[] {
    return sections.flatMap((section) => (section.expanded ? section.options : []));
  }

  private get trigger() {
    return this.querySelector<HTMLButtonElement>(".picker-select__trigger");
  }

  private closeMenu(restoreFocus = false) {
    clearTimeout(this.hoverTimer);
    if (this.sheetScroll) {
      this.sheetScroll.root.scrollTop = this.sheetScroll.top;
      this.sheetScroll = null;
    }
    this.hoverOpened = false;
    this.mode = "closed";
    this.query = "";
    this.collapsedGroups = new Set();
    this.activeValue = null;
    this.typeahead = "";
    this.ownerDocument.removeEventListener("pointerdown", this.handleOutsidePointer, true);
    // Tab's default action runs before Lit removes the panel's focus targets.
    this.querySelectorAll<HTMLElement>("[data-picker-focus]").forEach((element) => {
      element.tabIndex = -1;
    });
    if (restoreFocus) {
      this.trigger?.focus();
    }
  }

  private openMenu(last = false, focus = true) {
    if (this.params.disabled || this.mode !== "closed") {
      return undefined;
    }
    const { searchable } = this.params;
    this.mode =
      searchable === "always" || (searchable && (this.params.groupBy || this.options().length > 8))
        ? "search"
        : "compact";
    const choices = this.rows().filter((option) => !option.disabled);
    this.activeValue =
      choices.find((option) => option.value === this.params.value)?.value ??
      (last ? choices.at(-1) : choices[0])?.value ??
      null;
    this.ownerDocument.addEventListener("pointerdown", this.handleOutsidePointer, true);
    this.params.onOpen?.();
    void this.updateComplete.then(() => {
      if (this.mode === "closed") {
        return;
      }
      // A page covers its sheet from the top, whatever the sheet had scrolled to.
      const root = this.querySelector<HTMLElement>(".picker-select__menu")?.offsetParent;
      if (this.params.sheet && root) {
        this.sheetScroll = { root, top: root.scrollTop };
        root.scrollTop = 0;
      }
      // A tapped sheet page lands on Back so touch never pops the keyboard.
      const target =
        this.params.sheet && !this.keyboard ? ".picker-select__back" : "[data-picker-focus]";
      if (focus) {
        this.querySelector<HTMLElement>(target)?.focus({ preventScroll: true });
      }
      // The popup sizes its list after this render.
      requestAnimationFrame(this.syncScrollFade);
    });
    return this.mode;
  }

  override disconnectedCallback() {
    this.closeMenu();
    super.disconnectedCallback();
  }

  protected override willUpdate() {
    if (this.params.disabled && this.mode !== "closed") {
      this.closeMenu();
    }
    this.renderedSections = this.sections();
    if (this.mode !== "closed") {
      const choices = this.rows(this.renderedSections).filter((option) => !option.disabled);
      if (!choices.some((option) => option.value === this.activeValue)) {
        this.activeValue = choices[0]?.value ?? null;
      }
    }
  }

  private readonly syncScrollFade = () => {
    const list = this.querySelector<HTMLElement>(".picker-select__options");
    if (list) {
      list.toggleAttribute("data-fade-start", list.scrollTop > 0);
      list.toggleAttribute(
        "data-fade-end",
        list.scrollTop + list.clientHeight < list.scrollHeight - 1,
      );
    }
  };

  protected override updated(changed: PropertyValues) {
    this.configurePopup();
    this.syncScrollFade();
    if (this.mode === "closed" || (!changed.has("activeValue") && !changed.has("query"))) {
      return;
    }
    const menu = this.querySelector<HTMLElement>(".picker-select__options");
    const active = menu?.querySelector<HTMLElement>("[data-active]");
    if (menu && active) {
      revealInScrollRegion(menu, active);
    }
  }

  private commit(value: string | null) {
    const option = this.rows().find((row) => row.value === value);
    if (this.mode === "closed" || this.params.disabled || !option || option.disabled) {
      return;
    }
    this.closeMenu(true);
    if (this.params.onChangeTarget) {
      this.params.onChangeTarget(option.value, this);
    } else {
      this.params.onChange(option.value);
    }
  }

  private readonly handleOutsidePointer = (event: PointerEvent) => {
    if (!event.composedPath().includes(this)) {
      this.closeMenu();
    }
  };

  private readonly handleFocusOut = (event: FocusEvent) => {
    if (!(event.relatedTarget instanceof Node) || !this.contains(event.relatedTarget)) {
      this.closeMenu();
    }
  };

  // Mouse hover opens a submenu after a short intent delay and closes it after
  // a grace delay, so the pointer can cross the gap into the flyout. Touch and
  // pen input skip hover and keep click-to-toggle.
  private readonly handleHover = (event: PointerEvent) => {
    if (this.params.variant !== "submenu" || this.params.sheet || event.pointerType !== "mouse") {
      return;
    }
    clearTimeout(this.hoverTimer);
    const enter = event.type === "pointerenter";
    if (enter === (this.mode !== "closed")) {
      return;
    }
    this.hoverTimer = setTimeout(
      () => {
        if (enter) {
          this.keyboard = false;
          // Hover previews the choices without taking focus, so a later
          // close never hands a script-moved focus ring to the trigger.
          this.hoverOpened = this.openMenu(false, false) !== undefined;
        } else {
          this.closeMenu(this.contains(this.ownerDocument.activeElement));
        }
      },
      enter ? 120 : 150,
    );
  };

  private readonly handleTriggerClick = () => {
    clearTimeout(this.hoverTimer);
    this.keyboard = false;
    if (this.mode === "closed") {
      this.openMenu();
    } else if (this.hoverOpened) {
      // The click that follows a hover-open keeps the submenu open.
      this.hoverOpened = false;
    } else {
      this.closeMenu();
    }
  };

  private get submenuSide() {
    return getComputedStyle(this).direction === "rtl" ? "left" : "right";
  }

  private configurePopup() {
    const element = this.querySelector<WaPopup>("wa-popup");
    if (!(element instanceof WaPopup) || !this.trigger) {
      return;
    }
    // A narrow viewport may have no room on either side; retain the same choice
    // list above or below its row rather than letting a flyout leave the viewport.
    // The attribute converter is what splits this list into placements.
    // Other pickers keep Floating UI's default opposite-side fallback.
    if (this.params.variant === "submenu") {
      element.setAttribute(
        "flip-fallback-placements",
        `${this.submenuSide === "right" ? "left" : "right"}-start bottom-start top-start`,
      );
    }
    configureAnchoredPopup(
      element,
      this.trigger,
      this.params.variant === "submenu" ? this.submenuSide : (this.params.placement ?? "bottom"),
    );
  }

  private readonly handleKeydown = (event: KeyboardEvent) => {
    const editing = event.target instanceof HTMLInputElement;
    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    const submenu = this.params.variant === "submenu";
    const forward = this.submenuSide === "right" ? "ArrowRight" : "ArrowLeft";
    const back = forward === "ArrowRight" ? "ArrowLeft" : "ArrowRight";
    const opensMenu =
      ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key) ||
      (submenu && event.key === forward);
    if (
      (this.mode === "closed" && !opensMenu && !printable) ||
      // Back is a plain button; let Enter and Space activate it.
      ((event.key === "Enter" || event.key === " ") &&
        event.target instanceof Element &&
        event.target.matches(".picker-select__back"))
    ) {
      return;
    }
    // Typing a search query is not navigation; it leaves the rings off.
    if (!editing || !(printable || event.key === "Backspace" || event.key === "Delete")) {
      this.keyboard = true;
    }
    event.stopPropagation();
    if (event.isComposing || this.params.disabled) {
      return;
    }
    const now = performance.now();
    const typing = now - this.typeaheadAt < 1000 ? this.typeahead : "";
    if (this.mode === "closed") {
      if (opensMenu) {
        event.preventDefault();
        this.openMenu(event.key === "ArrowUp");
        return;
      }
      if (!printable) {
        return;
      }
      event.preventDefault();
      if (this.openMenu() === "search") {
        this.query = event.key;
        this.activeValue = null;
        return;
      }
    }
    if (event.key === "Escape" && this.query && this.params.searchable === "always") {
      event.preventDefault();
      this.query = "";
      return;
    }
    // Group headers are native buttons in the popup tab order; focusout owns leaving it.
    if (event.key === "Tab" && this.params.groupBy) {
      return;
    }
    if (
      event.key === "Escape" ||
      event.key === "Tab" ||
      (submenu && !editing && event.key === back)
    ) {
      if (event.key !== "Tab") {
        event.preventDefault();
      }
      this.closeMenu(true);
      return;
    }
    if (event.target instanceof Element && event.target.closest(".picker-select__group-toggle")) {
      return;
    }
    if (event.key === "Enter" || (event.key === " " && !editing && !typing)) {
      event.preventDefault();
      this.commit(this.activeValue);
      return;
    }
    if (editing && event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const choices = this.rows().filter((option) => !option.disabled);
    let index = choices.findIndex((option) => option.value === this.activeValue);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      index += event.key === "ArrowDown" ? 1 : -1;
      if (index < 0) {
        index = choices.length - 1;
      }
      if (index >= choices.length) {
        index = 0;
      }
    } else if (!editing && (event.key === "Home" || event.key === "End")) {
      event.preventDefault();
      index = event.key === "Home" ? 0 : choices.length - 1;
    } else if (!editing && (printable || event.key === "Backspace")) {
      event.preventDefault();
      this.typeahead =
        event.key === "Backspace" ? typing.slice(0, -1) : typing + event.key.toLocaleLowerCase();
      this.typeaheadAt = now;
      index = choices.findIndex((option) =>
        option.label.toLocaleLowerCase().startsWith(this.typeahead),
      );
    }
    const choice = choices[index];
    if (choice) {
      this.activeValue = choice.value;
    }
  };

  private leading(option: Option | undefined) {
    const content = option && this.params.renderLeading?.(option);
    return content === undefined || content === null || content === nothing
      ? nothing
      : html`<span class="picker-select__leading">${content}</span>`;
  }

  private optionId(value: string) {
    return `${this.listboxId}-option-${encodeURIComponent(JSON.stringify(value))}`;
  }

  private renderOption(option: Option, grouped: boolean, hidden = false) {
    return html`
      <div
        class="picker-select__option"
        role="option"
        id=${this.optionId(option.value)}
        data-value=${option.value}
        ?hidden=${hidden}
        title=${this.params.showOptionTooltips === false ? nothing : option.value}
        aria-selected=${String(option.value === this.params.value)}
        aria-disabled=${String(Boolean(option.disabled))}
        ?data-active=${option.value === this.activeValue}
        @mousedown=${(event: MouseEvent) => event.preventDefault()}
        @mousemove=${() => {
          this.keyboard = false;
          if (!option.disabled) {
            this.activeValue = option.value;
          }
        }}
        @click=${() => this.commit(option.value)}
      >
        ${grouped ? nothing : this.leading(option)}
        <span class="picker-select__copy">
          <span class="picker-select__label" style=${option.labelStyle ?? nothing}
            >${option.label}</span
          >
          ${option.description ? html`<span class="picker-select__description">${option.description}</span>` : nothing}
        </span>
        <span class="picker-select__check" aria-hidden="true"
          >${option.value === this.params.value ? icons.check : nothing}</span
        >
      </div>
    `;
  }

  override render() {
    const sections = this.renderedSections;
    const rows = this.rows(sections);
    const sectionIds = sections.map((_, index) => `${this.listboxId}-group-${index}`);
    const controls = this.params.groupBy ? sectionIds.join(" ") : this.listboxId;
    const allOptions = this.options();
    const visibleValues = new Set(rows.map((option) => option.value));
    const selected = allOptions.find((option) => option.value === this.params.value);
    const active = rows.find((option) => option.value === this.activeValue);
    const open = this.mode !== "closed";
    const menu = html`<div
      class=${`picker-select__menu ${this.params.groupBy ? "picker-select__menu--grouped" : ""}`}
    >
      ${
        this.params.sheet
          ? html`<div class="picker-select__page-header">
              <button
                type="button"
                class="picker-select__back"
                aria-label=${t("common.back")}
                @click=${() => this.closeMenu(true)}
              >
                ${icons.chevronLeft}
              </button>
              <span>${this.params.label}</span>
            </div>`
          : nothing
      }
      ${
        this.mode === "search"
          ? html` <input
              class="picker-select__search settings-input"
              type="search"
              role="combobox"
              data-picker-focus
              tabindex="0"
              autocomplete="off"
              spellcheck="false"
              aria-label=${t("common.search")}
              placeholder=${this.params.searchPlaceholder ?? t("common.search")}
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls=${controls}
              aria-invalid=${this.params.invalid ? "true" : nothing}
              aria-describedby=${this.params.describedBy ?? nothing}
              aria-activedescendant=${active ? this.optionId(active.value) : nothing}
              .value=${live(this.query)}
              @input=${(event: InputEvent) => {
                this.query = (event.currentTarget as HTMLInputElement).value;
                this.activeValue = null;
              }}
            />`
          : nothing
      }
      <div
        class="picker-select__options"
        role=${this.params.groupBy ? nothing : "listbox"}
        @scroll=${this.syncScrollFade}
        id=${this.params.groupBy ? nothing : this.listboxId}
        aria-label=${this.params.groupBy ? nothing : this.params.label}
        ?data-picker-focus=${this.mode === "compact"}
        tabindex=${this.mode === "compact" ? 0 : -1}
        aria-activedescendant=${this.mode === "compact" && active ? this.optionId(active.value) : nothing}
      >
        ${sections.map((section, groupIndex) => {
          const options = section.expanded
            ? repeat(
                this.params.groupBy ? section.options : allOptions,
                (option) => option.value,
                (option) =>
                  this.renderOption(
                    option,
                    Boolean(section.group),
                    !visibleValues.has(option.value),
                  ),
              )
            : nothing;
          const group = section.group;
          const groupId = sectionIds[groupIndex];
          if (!group) {
            return this.params.groupBy
              ? html`<div id=${groupId} role="listbox" aria-label=${this.params.label}>
                  ${options}
                </div>`
              : options;
          }
          return html`<div class="picker-select__group" role="group" aria-label=${group.label}>
            <button
              class="picker-select__group-toggle"
              type="button"
              tabindex=${open ? 0 : -1}
              aria-expanded=${String(section.expanded)}
              aria-controls=${groupId}
              ?disabled=${Boolean(this.query.trim())}
              @click=${() => {
                const collapsed = new Set(this.collapsedGroups);
                if (collapsed.has(group.id)) {
                  collapsed.delete(group.id);
                } else {
                  collapsed.add(group.id);
                }
                this.collapsedGroups = collapsed;
              }}
            >
              ${group.leading ?? nothing}<span class="picker-select__group-label"
                >${group.label}</span
              >
              <span>${section.options.length}</span
              ><span class="picker-select__chevron" aria-hidden="true">${icons.chevronDown}</span>
            </button>
            <div
              id=${groupId}
              class="picker-select__group-options"
              role="listbox"
              aria-label=${group.label}
            >
              ${options}
            </div>
          </div>`;
        })}
      </div>
      <div
        class="picker-select__empty"
        role="status"
        ?hidden=${sections.some((section) => section.options.length > 0)}
      >
        ${t("common.pickerNoMatches")}
      </div>
    </div>`;
    return html`
      <div
        @focusout=${this.handleFocusOut}
        @keydown=${this.handleKeydown}
        @pointerenter=${this.handleHover}
        @pointerleave=${this.handleHover}
        ?data-keyboard=${this.keyboard}
      >
        <button
          id=${this.params.id ?? nothing}
          class="picker-select__trigger"
          type="button"
          aria-label=${
            selected
              ? `${this.params.label}: ${[selected.label, this.params.showSelectedDescription && selected.description].filter(Boolean).join(" · ")}`
              : this.params.label
          }
          aria-haspopup="listbox"
          aria-expanded=${String(open)}
          aria-controls=${controls}
          aria-invalid=${this.params.invalid ? "true" : nothing}
          aria-describedby=${this.params.describedBy ?? nothing}
          title=${this.params.title ?? nothing}
          ?disabled=${this.params.disabled}
          @click=${this.handleTriggerClick}
        >
          ${this.params.variant === "submenu" ? html`<span class="picker-select__name">${this.params.label}</span>` : nothing}
          ${this.leading(selected)}
          <span class="picker-select__copy">
            <span class="picker-select__label">${selected?.label ?? this.params.label}</span>
            ${
              this.params.showSelectedDescription && selected?.description
                ? html`<span class="picker-select__description">${selected.description}</span>`
                : nothing
            }
          </span>
          <span class="picker-select__chevron" aria-hidden="true"
            >${
              this.params.variant === "submenu" || this.params.sheet
                ? icons.chevronRight
                : icons.chevronDown
            }</span
          >
        </button>
        ${
          this.params.sheet
            ? open
              ? menu
              : nothing
            : html`<wa-popup
                ?active=${open}
                sync=${this.params.variant === "submenu" ? nothing : "width"}
                >${menu}</wa-popup
              >`
        }
      </div>
    `;
  }
}

if (!customElements.get("openclaw-select-picker")) {
  customElements.define("openclaw-select-picker", SelectPicker);
}

export function renderPicker<Option extends PickerOption>(params: PickerParams<Option>) {
  return html`<openclaw-select-picker
    class=${`settings-select picker-select ${params.variant === "submenu" ? "picker-select--submenu" : ""} ${params.sheet ? "picker-select--sheet" : ""} ${params.className ?? ""}`}
    style="width:100%;min-width:min(138px,100%)"
    .params=${params}
  ></openclaw-select-picker>`;
}
