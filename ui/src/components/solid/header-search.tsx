import type { JSX } from "@solidjs/web";
import { onSettled } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import { Icon } from "./icon.tsx";
import "./overlay.css";

const SURFACE_SELECTOR = '[popover], [role="menu"], [role="dialog"], .picker-select__menu';
const HEADER_SELECTOR = ".header-search";

type HeaderSearchController = {
  type: (key: string) => boolean;
  surfaceClosed: () => void;
};

// Menus keep rendered content across close and reopen, so these outlive one mount's owner.
const controllers = new WeakMap<Element, HeaderSearchController>();
let surfacesWatched = false;

function ownHeaders(surface: Element) {
  return [...surface.querySelectorAll(HEADER_SELECTOR)].filter(
    (header) => header.closest(SURFACE_SELECTOR) === surface,
  );
}

/** Hover can open a submenu while focus stays in its parent, and focus can rest on the page. */
function headerForTyping(target: Element) {
  const visible = (header: Element) => header.checkVisibility();
  if (target === target.ownerDocument.body) {
    return [...target.querySelectorAll(HEADER_SELECTOR)].findLast(visible);
  }
  const surface = target.closest(SURFACE_SELECTOR);
  return (
    surface &&
    (ownHeaders(surface).find(visible) ??
      [...surface.querySelectorAll(HEADER_SELECTOR)].findLast(visible))
  );
}

function watchSurfaces() {
  if (surfacesWatched) {
    return;
  }
  surfacesWatched = true;
  // Typing anywhere on the surface starts a search, as the old focused field did.
  // The window phase runs before menu shortcuts claim the same letter.
  window.addEventListener(
    "keydown",
    (event) => {
      const target = event.target;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.key.length !== 1 ||
        event.key === " " ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        !(target instanceof Element) ||
        target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }
      const header = headerForTyping(target);
      if (header && controllers.get(header)?.type(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  // A surface reopened with no query starts from the title again.
  window.addEventListener(
    "toggle",
    (event) => {
      if (event.target instanceof Element && (event as ToggleEvent).newState === "closed") {
        for (const header of ownHeaders(event.target)) {
          controllers.get(header)?.surfaceClosed();
        }
      }
    },
    true,
  );
}

type HeaderSearchFieldProps = {
  label: string;
  placeholder?: string;
  query: string;
  disabled?: boolean;
  /** Search opened from a closed header takes focus; a restored query does not. */
  focus?: boolean;
  class?: string;
  inputProps?: JSX.InputHTMLAttributes<HTMLInputElement>;
  controlRef?: () => ((element: HTMLElement) => void) | undefined;
  inputRef?: (element: HTMLInputElement) => void;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  /** Lets a host leave Escape to another open overlay. */
  ownsEscape?: () => boolean;
};

export function HeaderSearchField(props: HeaderSearchFieldProps) {
  let input!: HTMLInputElement;
  onSettled(() => {
    if (props.focus !== false) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });
  const keydown = nativeListener("keydown", (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) {
      return;
    }
    if (event.key === "Escape") {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        input.ownerDocument.activeElement !== input ||
        props.ownsEscape?.() === false
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    props.onKeyDown?.(event);
  });
  return (
    <input
      {...props.inputProps}
      ref={[
        (element: HTMLInputElement) => {
          input = element;
          props.inputRef?.(element);
          props.controlRef?.()?.(element);
        },
        keydown,
        nativeListener("click", (event) => event.stopPropagation()),
      ]}
      class={["header-search__input", props.class]}
      type="search"
      autocomplete="off"
      spellcheck="false"
      aria-label={props.label}
      placeholder={props.placeholder ?? props.label}
      value={props.query}
      disabled={props.disabled}
      onInput={(event) => props.onQueryChange(event.currentTarget.value)}
    />
  );
}

export function HeaderSearchToggle(props: {
  open: boolean;
  label: string;
  closeLabel?: string;
  disabled?: boolean;
  controlRef?: () => ((element: HTMLElement) => void) | undefined;
  toggleRef?: (element: HTMLButtonElement) => void;
  onToggle: () => void;
}) {
  return (
    <button
      ref={[
        (element: HTMLButtonElement) => {
          props.toggleRef?.(element);
          props.controlRef?.()?.(element);
        },
        // Menus stop content clicks natively, before any delegated handler could run.
        nativeListener("click", (event) => {
          event.stopPropagation();
          props.onToggle();
        }),
      ]}
      type="button"
      class="header-search__toggle"
      data-form-control=""
      aria-label={props.open ? (props.closeLabel ?? t("common.close")) : props.label}
      disabled={props.disabled}
    >
      <Icon name={props.open ? "x" : "search"} />
    </button>
  );
}

export type HeaderSearchProps = {
  title: JSX.Element;
  leading?: JSX.Element;
  label: string;
  placeholder?: string;
  closeLabel?: string;
  query: string;
  open: boolean;
  disabled?: boolean;
  class?: string;
  inputClass?: string;
  inputProps?: JSX.InputHTMLAttributes<HTMLInputElement>;
  controlRef?: () => ((element: HTMLElement) => void) | undefined;
  inputRef?: (element: HTMLInputElement) => void;
  toggleRef?: (element: HTMLButtonElement) => void;
  onOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
  onInputKeyDown?: (event: KeyboardEvent) => void;
  ownsEscape?: () => boolean;
};

/** One header row that swaps its title for the search field while searching. */
export function HeaderSearch(props: HeaderSearchProps) {
  let toggle!: HTMLButtonElement;
  let focusField = false;
  const openSearch = () => {
    focusField = true;
    props.onOpenChange(true);
  };
  const close = () => {
    props.onQueryChange("");
    props.onOpenChange(false);
    toggle.focus({ preventScroll: true });
  };
  return (
    <div
      ref={(element) => {
        watchSurfaces();
        controllers.set(element, {
          type(key) {
            if (props.open || props.disabled) {
              return false;
            }
            focusField = true;
            props.onOpenChange(true);
            props.onQueryChange(key);
            return true;
          },
          surfaceClosed() {
            if (props.open && !props.query) {
              props.onOpenChange(false);
            }
          },
        });
      }}
      class={["header-search", props.class]}
      data-searching={props.open ? "" : undefined}
    >
      {props.leading}
      {props.open ? (
        <HeaderSearchField
          label={props.label}
          placeholder={props.placeholder}
          query={props.query}
          disabled={props.disabled}
          focus={focusField}
          class={props.inputClass}
          inputProps={props.inputProps}
          controlRef={props.controlRef}
          inputRef={props.inputRef}
          onQueryChange={props.onQueryChange}
          onClose={close}
          onKeyDown={props.onInputKeyDown}
          ownsEscape={props.ownsEscape}
        />
      ) : (
        <span class="header-search__title">{props.title}</span>
      )}
      <HeaderSearchToggle
        open={props.open}
        label={props.label}
        closeLabel={props.closeLabel}
        disabled={props.disabled}
        controlRef={props.controlRef}
        toggleRef={(element) => {
          toggle = element;
          props.toggleRef?.(element);
        }}
        onToggle={() => (props.open ? close() : openSearch())}
      />
    </div>
  );
}
