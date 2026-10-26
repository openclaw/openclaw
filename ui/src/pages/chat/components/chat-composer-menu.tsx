import type { JSX } from "@solidjs/web";
import { For, onSettled } from "solid-js";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { registerChatComposerInvocationMenu } from "./chat-picker-overlay.ts";

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
        if (!options.active && event.pointerType !== "touch") {
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
