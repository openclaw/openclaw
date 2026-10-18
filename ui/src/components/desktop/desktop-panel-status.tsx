import type { JSX } from "@solidjs/web";
import { Show, createEffect, createMemo, createSignal, onSettled } from "solid-js";
import { t } from "../../lib/reactive/i18n.ts";
import { Icon } from "../solid/icon.tsx";
import { PanelEmptyState } from "../solid/panel-empty-state.tsx";

/** Status chrome is a sibling of the retained remote surface, never its owner. */
export function DesktopStatusSurface(props: {
  heading: string;
  description?: string | null;
  pending?: boolean;
  overlay?: boolean;
  action?: JSX.Element;
}) {
  const icon = () => (
    <span class="desktop-status-surface__icon" aria-hidden="true">
      <Icon name="monitor" />
      {props.pending && <Icon name="loader" class="desktop-status-surface__spinner" />}
    </span>
  );
  return (
    <Show
      when={props.overlay}
      fallback={
        <div class="desktop-status-surface desktop-status-surface--anchored">
          <PanelEmptyState
            presentation="desktop"
            icon={icon()}
            heading={props.heading}
            description={props.description ?? ""}
            action={props.action}
          />
        </div>
      }
    >
      <div
        class={["desktop-status-surface", { "desktop-status-surface--overlay": props.overlay }]}
        role="status"
      >
        {icon()}
        <strong>{props.heading}</strong>
        {props.description && <p>{props.description}</p>}
        {props.action && <div class="desktop-status-surface__action">{props.action}</div>}
      </div>
    </Show>
  );
}

export function DesktopViewerHint(props: {
  stage: () => HTMLElement;
  active: boolean;
  fullscreen: boolean;
}) {
  let hint!: HTMLSpanElement;
  const [point, setPoint] = createSignal<{ x: number; y: number } | null>(null);
  const followsPointer = createMemo(() => props.active && props.fullscreen);
  const position = createMemo(() => {
    const current = point();
    return props.fullscreen && current
      ? { left: `${current.x}px`, top: `${current.y}px` }
      : undefined;
  });
  createEffect(followsPointer, () => {
    setPoint(null);
  });
  onSettled(() => {
    const stage = props.stage();
    const hide = () => {
      setPoint(null);
    };
    const move = (event: PointerEvent) => {
      if (!followsPointer()) {
        return;
      }
      const canvas = stage.querySelector(".desktop-surface canvas");
      if (!canvas) {
        hide();
        return;
      }
      const remote = canvas.getBoundingClientRect();
      const frame = stage.getBoundingClientRect();
      const left = Math.max(remote.left, frame.left);
      const right = Math.min(remote.right, frame.right);
      const top = Math.max(remote.top, frame.top);
      const bottom = Math.min(remote.bottom, frame.bottom);
      if (
        event.clientX < left ||
        event.clientX > right ||
        event.clientY < top ||
        event.clientY > bottom
      ) {
        hide();
        return;
      }
      setPoint({
        x:
          Math.max(left + 8, Math.min(event.clientX + 16, right - hint.offsetWidth - 8)) -
          frame.left,
        y:
          Math.max(top + 8, Math.min(event.clientY + 18, bottom - hint.offsetHeight - 8)) -
          frame.top,
      });
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerleave", hide);
    return () => {
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerleave", hide);
    };
  });
  return (
    <span
      ref={(element) => {
        hint = element;
      }}
      class="desktop-viewer-hint"
      aria-hidden="true"
      data-active={props.active ? "true" : "false"}
      data-fullscreen={props.fullscreen ? "true" : "false"}
      data-positioned={point() ? "true" : "false"}
      style={position()}
    >
      {t("desktop.clickToTakeControl")}
    </span>
  );
}
