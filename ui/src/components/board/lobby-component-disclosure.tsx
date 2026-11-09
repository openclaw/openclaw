import type { JSX } from "@solidjs/web";
import { createSignal, createUniqueId, Show } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { createResizeObserver } from "../../lib/reactive/observers.ts";
import { Icon } from "../solid/icon.tsx";
import type { BoardWidgetCellProps } from "./board-widget-cell-options.ts";

export function createLobbyComponentDisclosure(
  props: BoardWidgetCellProps,
  root: () => HTMLElement | undefined,
) {
  const collapsed = () => !props.lobbyPage;
  const [width, setWidth] = createSignal(360);
  const [pageHeight, setPageHeight] = createSignal(360);
  const [button, setButton] = createSignal<HTMLButtonElement>();
  const [slot, setSlot] = createSignal<HTMLSpanElement>();
  const [preview, setPreview] = createSignal({ x: 0, y: 0, width: 88, height: 88 });
  const id = createUniqueId();
  // The button changes width when permissions/capability badges change. Observe
  // it too, so the retained document always follows its real thumbnail slot.
  createResizeObserver(
    () => {
      const elements: HTMLElement[] = [];
      const container = root();
      const toggle = button();
      const thumbnail = slot();
      const viewport = container?.closest("openclaw-board-view");
      if (viewport instanceof HTMLElement) {
        elements.push(viewport);
      }
      if (container) {
        elements.push(container);
      }
      if (toggle) {
        elements.push(toggle);
      }
      if (thumbnail?.clientWidth && thumbnail.clientHeight) {
        elements.push(thumbnail);
      }
      return elements;
    },
    () => {
      const container = root();
      const thumbnail = slot();
      if (container?.clientWidth) {
        setWidth(container.clientWidth);
      }
      const viewport = container?.closest("openclaw-board-view");
      if (viewport instanceof HTMLElement && viewport.clientHeight) {
        const padding = getComputedStyle(viewport);
        const chrome = button()?.closest<HTMLElement>(".board-widget__chrome");
        const available =
          viewport.clientHeight -
          Number.parseFloat(padding.paddingTop || "0") -
          Number.parseFloat(padding.paddingBottom || "0") -
          (chrome?.clientHeight ?? 96) -
          2;
        setPageHeight(Math.max(120, available));
      }
      if (thumbnail) {
        setPreview({
          x: thumbnail.offsetLeft + thumbnail.clientLeft,
          y: thumbnail.offsetTop + thumbnail.clientTop,
          width: thumbnail.clientWidth,
          height: thumbnail.clientHeight,
        });
      }
    },
  );
  const style = (): JSX.CSSProperties => {
    const side = width();
    const target = preview();
    const scale = Math.min(target.width / side, target.height / side, 1);
    return {
      order: props.positionInSet ?? 1,
      height: collapsed() ? "98px" : undefined,
      "--lobby-source-side": `${side}px`,
      "--lobby-page-height": `${pageHeight()}px`,
      "--lobby-preview-scale": scale,
      "--lobby-preview-top": `${target.y}px`,
      "--lobby-preview-left": `${target.x + (target.width - side * scale) / 2}px`,
    };
  };
  return {
    collapsed,
    id,
    style,
    setButton,
    setSlot,
    focus: () => button()?.focus({ preventScroll: true }),
    toggle: () => {
      props.onLobbyOpen?.();
    },
  };
}

export function LobbyComponentHeader(props: {
  title: string;
  description?: string;
  disclosure: ReturnType<typeof createLobbyComponentDisclosure>;
}) {
  return (
    <div
      class={[
        "lobby-component__heading",
        { "lobby-component__heading--page": !props.disclosure.collapsed() },
      ]}
    >
      <button
        type="button"
        class="lobby-component__toggle"
        ref={props.disclosure.setButton}
        aria-label={t(props.disclosure.collapsed() ? "board.lobby.open" : "board.lobby.back", {
          title: props.title,
        })}
        aria-controls={props.disclosure.id}
        onClick={() => props.disclosure.toggle()}
      >
        <Show when={!props.disclosure.collapsed()}>
          <Icon name="chevronLeft" />
        </Show>
        <span class="board-widget__title">{props.title}</span>
        <Show when={props.description}>
          <span class="lobby-component__description">{props.description}</span>
        </Show>
        <Show when={props.disclosure.collapsed()}>
          <span
            ref={props.disclosure.setSlot}
            class="lobby-component__preview-slot"
            aria-hidden="true"
          />
        </Show>
        <Show when={props.disclosure.collapsed()}>
          <Icon name="chevronRight" />
        </Show>
      </button>
    </div>
  );
}
