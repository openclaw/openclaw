import type { JSX } from "@solidjs/web";
import { createSignal, onSettled } from "solid-js";
import { widgetInspectionAnchor } from "../../../components/canvas-widget-inspection.ts";
import type { OpenClawCanvasWidgetView } from "../../../components/canvas-widget-view.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { showToast } from "../../../lib/toast.ts";
import { WIDGET_COMMENT_INTENT, type WidgetCommentIntent } from "./widget-comment-intent.ts";

// Only the deferred widget renderer needs this overlay; it does not ship with chat CSS.
export function widgetInspectionOutlineStyle(rect: DOMRect): JSX.CSSProperties {
  return {
    position: "absolute",
    "z-index": 1,
    "pointer-events": "none",
    border: "2px solid var(--accent)",
    background: "color-mix(in srgb, var(--accent) 8%, transparent)",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

export function createWidgetCommentInteraction(props: {
  source: () => OpenClawCanvasWidgetView | undefined;
  title: () => string;
  enabled: () => boolean;
}) {
  const [inspecting, setInspecting] = createSignal(false);
  const [outline, setOutline] = createSignal<DOMRect>();
  let panel!: HTMLDivElement;
  let annotationButton: HTMLButtonElement | undefined;
  let stopInspection: (() => void) | undefined;
  let editor: AbortController | undefined;
  const focusPen = () => annotationButton?.focus({ preventScroll: true });
  const reset = () => {
    stopInspection?.();
    editor?.abort();
    editor = undefined;
  };
  onSettled(() => reset);
  const toggleAnnotation = () => {
    if (stopInspection) {
      stopInspection();
      return;
    }
    const source = props.source();
    if (!source) {
      return;
    }
    editor?.abort();
    const listeners = new AbortController();
    const stop = source.startInspection((event) => {
      if (event.kind === "cancel") {
        listeners.abort();
        stopInspection = undefined;
        setInspecting(false);
        setOutline(undefined);
        if (document.activeElement === source.previewFrame) {
          focusPen();
        }
        return;
      }
      if (event.kind === "hover") {
        const frame = source.previewFrame;
        const rect = event.rect;
        if (frame && rect) {
          const box = widgetInspectionAnchor(frame, rect);
          const panelBox = panel.getBoundingClientRect();
          const scaleX = panelBox.width / panel.offsetWidth || 1;
          const scaleY = panelBox.height / panel.offsetHeight || 1;
          setOutline(
            new DOMRect(
              (box.left - panelBox.left) / scaleX,
              (box.top - panelBox.top) / scaleY,
              box.width / scaleX,
              box.height / scaleY,
            ),
          );
        } else {
          setOutline(undefined);
        }
        return;
      }
      const anchor = widgetInspectionAnchor(event.frame, event.rect);
      stopInspection?.();
      const owner = new AbortController();
      editor = owner;
      const detail: WidgetCommentIntent = {
        text: `${props.title()} — ${event.label}`,
        anchor,
        signal: owner.signal,
        current: () =>
          panel.isConnected &&
          source.presentationActive &&
          props.source() === source &&
          source.previewFrame === event.frame &&
          props.enabled(),
        onCancel: focusPen,
      };
      if (
        panel.dispatchEvent(
          new CustomEvent(WIDGET_COMMENT_INTENT, { detail, bubbles: true, cancelable: true }),
        )
      ) {
        owner.abort();
        focusPen();
      }
    });
    if (!stop) {
      showToast({ severity: "error", message: t("chat.toolCards.widgetInspectUnavailable") });
      return;
    }
    stopInspection = stop;
    setInspecting(true);
    listen(
      document,
      "pointerdown",
      (event) => {
        if (
          event.target !== annotationButton &&
          !(event.target instanceof Node && annotationButton?.contains(event.target))
        ) {
          stop();
        }
      },
      { capture: true, signal: listeners.signal },
    );
    listen(
      document,
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          stop();
          focusPen();
        }
      },
      { signal: listeners.signal },
    );
  };
  return {
    inspecting,
    outline,
    toggleAnnotation,
    reset,
    setPanel: (element: HTMLDivElement) => {
      panel = element;
    },
    setPen: (element: HTMLButtonElement) => {
      annotationButton = element;
    },
  };
}
