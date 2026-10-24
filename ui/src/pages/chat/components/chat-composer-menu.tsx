import type { JSX } from "@solidjs/web";
import { onSettled } from "solid-js";
import { useScrollState } from "../../../components/solid/scroll-state.ts";
import { registerChatComposerInvocationMenu } from "./chat-picker-overlay.ts";

export { handleComposerMenuKeydown } from "../../../components/composer-menu.ts";

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
        <span class="slash-menu-name">{options.name}</span>
        <span class="slash-menu-desc">{options.description}</span>
      </span>
    </div>
  );
}
