import type { JSX } from "@solidjs/web";
import { onSettled } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
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
  toggleRef?: (element: HTMLButtonElement) => void;
  typeToSearch?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      ref={[
        props.controlRef?.(),
        (element: HTMLButtonElement) => {
          props.toggleRef?.(element);
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
      data-search-toggle={props.typeToSearch && !props.open ? "" : undefined}
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
  let root!: HTMLDivElement;
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
  onSettled(() => {
    // Menu entries can be built before insertion, while their nodes belong to a template document.
    const ownerDocument = document;
    const releaseTyping = listen(
      ownerDocument,
      "keydown",
      (event) => {
        if (
          event.defaultPrevented ||
          event.isComposing ||
          event.keyCode === 229 ||
          props.open ||
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
            )
        ) {
          return;
        }
        // The overlay owner chooses the active card, including hover-opened submenus.
        const active = registryFor(ownerDocument).stack.at(-1);
        if (!active?.open || !active.surface.contains(root) || !root.checkVisibility()) {
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        focusField = true;
        props.onOpenChange(true);
        props.onQueryChange(event.key);
      },
      true,
    );
    const releaseClose = listen(
      ownerDocument,
      "overlay-after-hide",
      (event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.contains(root) &&
          props.open &&
          !props.query
        ) {
          props.onOpenChange(false);
        }
      },
      true,
    );
    return () => {
      releaseTyping();
      releaseClose();
    };
  });
  return (
    <div
      ref={(element) => (root = element)}
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
        typeToSearch
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
