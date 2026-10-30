import type { JSX } from "@solidjs/web";
import { createContext, For, onSettled, useContext } from "solid-js";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { registerChatComposerInvocationMenu } from "./chat-picker-overlay.ts";

const ComposerMenuPointer = createContext<((event: PointerEvent) => boolean) | null>(null);

/** Keep option semantics and geometry while their visual renderer loads. */
export function ComposerMenuLoadingRows(props: {
  rows: readonly {
    id: string;
    name: string;
    description?: string;
    select: () => void;
    hover: () => void;
  }[];
  activeId: string | null | undefined;
  preserveFocus?: boolean;
}) {
  const Option = renderComposerMenuOption;
  return (
    <div aria-busy="true">
      <For each={props.rows} keyed={false}>
        {(row) => (
          <Option
            id={row().id}
            active={row().id === props.activeId}
            preserveFocus={props.preserveFocus}
            select={() => row().select()}
            hover={() => row().hover()}
            iconHidden={true}
            icon={
              <span class="skeleton" style={{ display: "block", width: "100%", height: "100%" }} />
            }
            name={
              <span class="skeleton" style={{ display: "block" }}>
                <span style={{ opacity: 0 }}>{row().name}</span>
              </span>
            }
            description={
              <span class="skeleton" style={{ display: "block" }}>
                <span style={{ opacity: 0 }}>{row().description}</span>
              </span>
            }
          />
        )}
      </For>
    </div>
  );
}

export function ComposerMenu(options: {
  id: string;
  label: string;
  class?: string;
  trackScroll?: boolean;
  activeId?: string | null;
  getTextarea?: () => HTMLTextAreaElement | null;
  children: JSX.Element;
  revision: unknown;
}) {
  let element!: HTMLDivElement;
  let pointerX: number | undefined;
  let pointerY: number | undefined;
  const pointerMoved = (event: PointerEvent) => {
    const moved = event.clientX !== pointerX || event.clientY !== pointerY;
    pointerX = event.clientX;
    pointerY = event.clientY;
    return moved;
  };
  onSettled(() =>
    options.getTextarea
      ? registerChatComposerInvocationMenu(element, options.getTextarea)
      : undefined,
  );
  const scrollRef = useScrollState(false, options.trackScroll !== false, {
    revision: () => options.revision,
    activeId: () => options.activeId,
  });
  return (
    <ComposerMenuPointer value={pointerMoved}>
      <div
        ref={(node) => (element = node)}
        id={options.id}
        class={["slash-menu", options.class]}
        role="listbox"
        aria-label={options.label}
      >
        <div class="slash-menu__scroll" ref={scrollRef}>
          {options.children}
        </div>
      </div>
    </ComposerMenuPointer>
  );
}

export function renderComposerMenuOption(options: {
  id: string;
  active: boolean;
  select: () => void;
  hover: () => void;
  preserveFocus?: boolean;
  icon: JSX.Element;
  iconHidden?: boolean;
  name: JSX.Element;
  description: JSX.Element;
}) {
  const pointerMoved = useContext(ComposerMenuPointer);
  return (
    <div
      id={options.id}
      class={["slash-menu-item", { "slash-menu-item--active": options.active }]}
      role="option"
      aria-selected={options.active ? "true" : "false"}
      onMouseDown={(event: MouseEvent) => {
        if (options.preserveFocus !== false) {
          event.preventDefault();
        }
      }}
      onClick={() => options.select()}
      onPointerMove={(event: PointerEvent) => {
        if (event.pointerType === "touch") {
          return;
        }
        // Keyboard scrolling can move a new row under a stationary pointer.
        const moved = pointerMoved?.(event) ?? true;
        if (moved && !options.active) {
          options.hover();
        }
      }}
    >
      <span class="slash-menu-icon" aria-hidden={options.iconHidden ? "true" : undefined}>
        {options.icon}
      </span>
      <span class="slash-menu-copy">
        <span class="slash-menu-name">{options.name}</span>{" "}
        <span class="slash-menu-desc">{options.description}</span>
      </span>
    </div>
  );
}
