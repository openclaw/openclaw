import type { JSX } from "@solidjs/web";
import { createSignal, onSettled, Show } from "solid-js";
import { keyboardHints } from "../../lib/keyboard-hints.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { keyboardHintsVisible } from "../../lib/reactive/keyboard-hints.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { nativeListener } from "../../lib/solid-native-listener.ts";
import { registryFor } from "../overlay-registry.ts";
import { Icon } from "./icon.tsx";
import "./overlay.css";

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
        props.controlRef?.(),
        (element: HTMLInputElement) => {
          input = element;
          props.inputRef?.(element);
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
  onToggle: () => void;
}) {
  return (
    <button
      ref={[
        props.controlRef?.(),
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
  leading?: JSX.Element;
  label: string;
  placeholder?: string;
  clearLabel?: string;
  query: string;
  disabled?: boolean;
  /**
   * Takes focus when a hardware keyboard is likely: "popover" whenever its surface opens,
   * "menu" as the menu's initial item. Menus without it keep row focus and still search on typing.
   */
  autofocus?: "popover" | "menu";
  class?: string;
  inputClass?: string;
  inputProps?: JSX.InputHTMLAttributes<HTMLInputElement>;
  controlRef?: () => ((element: HTMLElement) => void) | undefined;
  inputRef?: (element: HTMLInputElement) => void;
  onQueryChange: (query: string) => void;
  onInputKeyDown?: (event: KeyboardEvent) => void;
  /** Lets a host leave Escape to another open overlay. */
  ownsEscape?: () => boolean;
};

/** The search row that heads a card: always visible, so the list below filters as you type. */
export function HeaderSearch(props: HeaderSearchProps) {
  let root!: HTMLDivElement;
  let input!: HTMLInputElement;
  // A phone sheet holds its full height while the on-screen keyboard is up.
  const [focused, setFocused] = createSignal(false);
  const focusInput = () => {
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  };
  onSettled(() => {
    // Menu entries can be built before insertion, while their nodes belong to a template document.
    const ownerDocument = document;
    const owner = () => {
      // The overlay owner chooses the active card, including hover-opened submenus.
      const active = registryFor(ownerDocument).stack.at(-1);
      return active?.open && active.surface.contains(root) && root.checkVisibility()
        ? active.surface
        : undefined;
    };
    // A lazily loaded card can arrive after its surface's native autofocus has run.
    if (props.autofocus === "popover" && !props.disabled && keyboardHints.visible()) {
      const surface = owner();
      const active = ownerDocument.activeElement;
      if (
        surface &&
        (!active ||
          active === ownerDocument.body ||
          active === surface ||
          !surface.contains(active))
      ) {
        focusInput();
      }
    }
    return listen(
      ownerDocument,
      "keydown",
      (event) => {
        if (
          event.defaultPrevented ||
          event.isComposing ||
          event.keyCode === 229 ||
          props.disabled ||
          event.key.length !== 1 ||
          event.key === " " ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event
            .composedPath()
            .some(
              (target) =>
                target instanceof Element &&
                target.matches('input, textarea, select, [contenteditable="true"]'),
            ) ||
          !owner()
        ) {
          return;
        }
        // Typing on a list row searches: the key lands in the field, not in row typeahead.
        focusInput();
        event.stopImmediatePropagation();
      },
      true,
    );
  });
  return (
    <div
      ref={[
        (element) => (root = element),
        // The whole row reads as the field, including its icon and padding.
        nativeListener("click", (event) => {
          if (!(event.target instanceof Element && event.target.closest("button, input"))) {
            focusInput();
          }
        }),
      ]}
      class={["header-search", props.class]}
      data-searching={props.query || focused() ? "" : undefined}
      onFocusIn={() => setFocused(true)}
      onFocusOut={(event) =>
        setFocused(event.relatedTarget instanceof Node && root.contains(event.relatedTarget))
      }
    >
      {props.leading}
      <span class="header-search__icon" aria-hidden="true">
        <Icon name="search" />
      </span>
      <HeaderSearchField
        label={props.label}
        placeholder={props.placeholder}
        query={props.query}
        disabled={props.disabled}
        focus={false}
        class={props.inputClass}
        inputProps={{
          ...props.inputProps,
          autofocus: props.autofocus === "popover" && keyboardHintsVisible(),
          "data-initial-focus":
            props.autofocus === "menu" && keyboardHintsVisible() ? "" : undefined,
        }}
        controlRef={props.controlRef}
        inputRef={(element) => {
          input = element;
          props.inputRef?.(element);
        }}
        onQueryChange={props.onQueryChange}
        onClose={() => props.onQueryChange("")}
        onKeyDown={props.onInputKeyDown}
        // Escape clears a query first; an empty field leaves it to the surface.
        ownsEscape={() => Boolean(props.query) && props.ownsEscape?.() !== false}
      />
      <Show when={props.query && !props.disabled}>
        <button
          ref={[
            props.controlRef?.(),
            // Menus stop content clicks natively, before any delegated handler could run.
            nativeListener("click", (event) => {
              event.stopPropagation();
              props.onQueryChange("");
              focusInput();
            }),
          ]}
          type="button"
          class="header-search__clear"
          data-form-control=""
          aria-label={props.clearLabel ?? t("common.clearSearch")}
        >
          <Icon name="x" />
        </button>
      </Show>
    </div>
  );
}
