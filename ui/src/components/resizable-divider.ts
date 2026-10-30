import { spread } from "@solidjs/web";
import { t } from "../lib/reactive/i18n.ts";
import { createPointerDrag } from "../lib/reactive/pointer-drag.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lib/solid-bridge.ts";
import { nativeListener } from "../lib/solid-native-listener.ts";
import "./resizable-divider.css";

type ResizableDividerProps = {
  splitRatio: number;
  minRatio: number;
  maxRatio: number;
  label: string;
  orientation: "vertical" | "horizontal";
  measureRatio?: () => number;
  measureSize?: () => number;
};

type ResizableDividerElement = SolidBridgeElement<ResizableDividerProps>;

/** Dispatches resize-start, resize, and resize-end from the split-view separator. */
defineSolidBridge<ResizableDividerProps>(
  "resizable-divider",
  (props, host) => {
    let startPosition = 0;
    let startRatio = 0;
    let dragRatio = 0;
    let dragSize = 0;
    let dragFrame = 0;
    let pendingPosition: number | null = null;
    const drag = createPointerDrag();

    const handlePointerDown = (e: PointerEvent) => {
      if (e.button !== 0) {
        return;
      }
      const size = measureDragSize();
      if (
        size <= 0 ||
        !drag.start(e, host, {
          move: handlePointerMove,
          end: finishDragging,
          cancel: finishDragging,
        })
      ) {
        return;
      }
      startPosition = props.orientation === "horizontal" ? e.clientY : e.clientX;
      startRatio = currentRatio();
      dragRatio = startRatio;
      dragSize = size;
      host.classList.add("dragging");

      e.preventDefault();
      host.dispatchEvent(new CustomEvent("resize-start", { bubbles: true, composed: true }));
    };

    const handlePointerMove = (e: PointerEvent) => {
      pendingPosition = props.orientation === "horizontal" ? e.clientY : e.clientX;
      if (!dragFrame) {
        dragFrame = requestAnimationFrame(flushPointerMove);
      }
    };

    const flushPointerMove = () => {
      dragFrame = 0;
      const position = pendingPosition;
      pendingPosition = null;
      if (position !== null) {
        dragRatio = emitResize(startRatio + (position - startPosition) / dragSize);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const step = e.shiftKey ? 0.05 : 0.02;
      let nextRatio: number | null = null;

      const decreaseKey = props.orientation === "horizontal" ? "ArrowUp" : "ArrowLeft";
      const increaseKey = props.orientation === "horizontal" ? "ArrowDown" : "ArrowRight";
      if (e.key === decreaseKey) {
        nextRatio = currentRatio() - step;
      } else if (e.key === increaseKey) {
        nextRatio = currentRatio() + step;
      } else if (e.key === "Home") {
        nextRatio = props.minRatio;
      } else if (e.key === "End") {
        nextRatio = props.maxRatio;
      }

      if (nextRatio == null) {
        return;
      }

      e.preventDefault();
      emitResize(nextRatio);
      emitResize(nextRatio, "resize-end");
    };

    const finishDragging = () => {
      if (dragFrame) {
        cancelAnimationFrame(dragFrame);
        dragFrame = 0;
      }
      flushPointerMove();
      emitResize(dragRatio, "resize-end");
      host.classList.remove("dragging");
    };

    function emitResize(nextRatio: number, type: "resize" | "resize-end" = "resize") {
      const splitRatio = clampRatio(nextRatio);
      if (type === "resize") {
        setCurrentAriaValue(splitRatio);
      }
      host.dispatchEvent(
        new CustomEvent(type, {
          detail: { splitRatio },
          bubbles: true,
          composed: true,
        }),
      );
      return splitRatio;
    }

    function clampRatio(value: number) {
      return Math.max(props.minRatio, Math.min(props.maxRatio, value));
    }

    function measureDragSize() {
      const measuredSize = props.measureSize?.() ?? 0;
      if (measuredSize > 0) {
        return measuredSize;
      }
      const previousBounds = host.previousElementSibling?.getBoundingClientRect();
      const nextBounds = host.nextElementSibling?.getBoundingClientRect();
      const dimension = props.orientation === "horizontal" ? "height" : "width";
      const siblingSize = (previousBounds?.[dimension] ?? 0) + (nextBounds?.[dimension] ?? 0);
      if (siblingSize > 0) {
        return siblingSize;
      }
      const containerBounds = host.parentElement?.getBoundingClientRect();
      return containerBounds?.[dimension] ?? 0;
    }

    function currentRatio() {
      const measuredRatio = props.measureRatio?.();
      return measuredRatio !== undefined && Number.isFinite(measuredRatio)
        ? clampRatio(measuredRatio)
        : props.splitRatio;
    }

    function toAriaValue(value: number) {
      return Math.round(value * 100);
    }

    function setCurrentAriaValue(value: number) {
      setAttribute("aria-valuenow", String(toAriaValue(value)));
    }

    function setAttribute(name: string, value: string) {
      if (host.getAttribute(name) !== value) {
        host.setAttribute(name, value);
      }
    }

    nativeListener("pointerdown", handlePointerDown)(host);
    nativeListener("keydown", handleKeyDown)(host);
    spread(
      host,
      () => ({
        role: "separator",
        tabindex: "0",
        "aria-valuemin": String(toAriaValue(props.minRatio)),
        "aria-valuemax": String(toAriaValue(props.maxRatio)),
        "aria-valuenow": String(toAriaValue(props.splitRatio)),
        "aria-label": props.label || t("common.resizeSplitView"),
        "aria-orientation": props.orientation,
      }),
      true,
    );
    return undefined;
  },
  {
    properties: {
      splitRatio: { default: 0.6, type: Number },
      minRatio: { default: 0.4, type: Number },
      maxRatio: { default: 0.7, type: Number },
      label: { default: "" },
      orientation: { default: "vertical", reflect: true },
      measureRatio: { default: undefined, attribute: false },
      measureSize: { default: undefined, attribute: false },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "resizable-divider": ResizableDividerElement;
  }
}
