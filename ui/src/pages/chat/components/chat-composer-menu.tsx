import type { JSX } from "@solidjs/web";
import { createRenderEffect, onCleanup } from "solid-js";
import { revealInScrollRegion } from "../../../components/scroll-state.ts";

export { handleComposerMenuKeydown } from "../../../components/composer-menu.ts";

export function composerScrollStateRef(revision: () => unknown, trackScroll = true) {
  let element: HTMLElement | undefined;
  const sync = () => {
    if (!element?.isConnected) {
      return;
    }
    const scrollable = element.scrollHeight > element.clientHeight + 1;
    element.dataset.scrollable = String(scrollable);
    element.dataset.atStart = String(!scrollable || element.scrollTop <= 1);
    element.dataset.atEnd = String(
      !scrollable || element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
    );
  };
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(sync);
  createRenderEffect(revision, () => queueMicrotask(sync));
  onCleanup(() => {
    observer?.disconnect();
    element?.removeEventListener("scroll", sync);
    element = undefined;
  });
  return (node: HTMLElement) => {
    element = node;
    observer?.observe(node);
    if (trackScroll) {
      node.addEventListener("scroll", sync);
    }
    queueMicrotask(sync);
  };
}

export function ComposerMenu(options: {
  id: string;
  label: string;
  class?: string;
  trackScroll?: boolean;
  activeId?: string | null;
  children: JSX.Element;
  revision: unknown;
}) {
  let region: HTMLDivElement | undefined;
  let disposed = false;
  const scrollRef = composerScrollStateRef(() => options.revision, options.trackScroll !== false);
  onCleanup(() => {
    disposed = true;
  });
  const attach = (element: HTMLDivElement) => {
    region = element;
    scrollRef(element);
  };
  createRenderEffect(
    () => options.activeId,
    (activeId) => {
      if (!activeId) {
        return;
      }
      requestAnimationFrame(() => {
        const active = document.getElementById(activeId);
        if (!disposed && active && region) {
          revealInScrollRegion(region, active);
        }
      });
    },
  );
  return (
    <div
      id={options.id}
      class={`slash-menu ${options.class ?? ""}`}
      role="listbox"
      aria-label={options.label}
    >
      <div class="slash-menu__scroll" ref={attach}>
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
      class={`slash-menu-item ${options.active ? "slash-menu-item--active" : ""}`}
      role="option"
      aria-selected={options.active ? "true" : "false"}
      onMouseDown={
        options.preserveFocus === false ? undefined : (event: MouseEvent) => event.preventDefault()
      }
      onClick={options.select}
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
