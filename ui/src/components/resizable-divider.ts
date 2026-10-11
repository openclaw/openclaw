import { createRenderEffect, onCleanup } from "solid-js";
import { t } from "../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import "./resizable-divider.css";

const DRAG_END_EVENTS = ["pointerup", "pointercancel", "blur"] as const;

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
    let activePointerId: number | null = null;

    const handlePointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || activePointerId !== null) {
        return;
      }
      startPosition = props.orientation === "horizontal" ? e.clientY : e.clientX;
      startRatio = currentRatio();
      dragRatio = startRatio;
      dragSize = measureDragSize();
      if (dragSize <= 0) {
        return;
      }
      host.classList.add("dragging");
      activePointerId = e.pointerId;
      if (typeof host.setPointerCapture === "function") {
        host.setPointerCapture(e.pointerId);
      }

      window.addEventListener("pointermove", handlePointerMove);
      for (const type of DRAG_END_EVENTS) {
        window.addEventListener(type, finishDragging);
      }
      host.addEventListener("lostpointercapture", finishDragging);

      e.preventDefault();
      host.dispatchEvent(new CustomEvent("resize-start", { bubbles: true, composed: true }));
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (e.pointerId !== activePointerId) {
        return;
      }

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
      const ratio = currentRatio();
      let nextRatio: number | null = null;

      const decreaseKey = props.orientation === "horizontal" ? "ArrowUp" : "ArrowLeft";
      const increaseKey = props.orientation === "horizontal" ? "ArrowDown" : "ArrowRight";
      if (e.key === decreaseKey) {
        nextRatio = ratio - step;
      } else if (e.key === increaseKey) {
        nextRatio = ratio + step;
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

    const finishDragging = (event: Event) => {
      if ("pointerId" in event && event.pointerId !== activePointerId) {
        return;
      }
      if (activePointerId !== null) {
        if (dragFrame) {
          cancelAnimationFrame(dragFrame);
          dragFrame = 0;
        }
        flushPointerMove();
        emitResize(dragRatio, "resize-end");
      }
      const pointerId = activePointerId;
      if (pointerId === null) {
        return;
      }
      host.classList.remove("dragging");
      // Releasing capture can synchronously report capture loss. Remove the
      // listener first so one owner end cannot emit resize-end twice.
      host.removeEventListener("lostpointercapture", finishDragging);
      activePointerId = null;
      if (
        typeof host.releasePointerCapture === "function" &&
        (typeof host.hasPointerCapture !== "function" || host.hasPointerCapture(pointerId))
      ) {
        host.releasePointerCapture(pointerId);
      }
      if (dragFrame) {
        cancelAnimationFrame(dragFrame);
        dragFrame = 0;
      }
      pendingPosition = null;

      window.removeEventListener("pointermove", handlePointerMove);
      for (const type of DRAG_END_EVENTS) {
        window.removeEventListener(type, finishDragging);
      }
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
      host.setAttribute("aria-valuenow", String(toAriaValue(value)));
    }

    host.setAttribute("role", "separator");
    host.setAttribute("tabindex", "0");
    host.addEventListener("pointerdown", handlePointerDown);
    host.addEventListener("keydown", handleKeyDown);
    createRenderEffect(
      () => ({
        min: toAriaValue(props.minRatio),
        max: toAriaValue(props.maxRatio),
        value: currentRatio(),
        label: props.label || t("common.resizeSplitView"),
        orientation: props.orientation,
      }),
      (value) => {
        host.setAttribute("aria-valuemin", String(value.min));
        host.setAttribute("aria-valuemax", String(value.max));
        setCurrentAriaValue(value.value);
        host.setAttribute("aria-label", value.label);
        host.setAttribute("aria-orientation", value.orientation);
      },
    );
    onCleanup(() => {
      host.removeEventListener("pointerdown", handlePointerDown);
      host.removeEventListener("keydown", handleKeyDown);
      finishDragging(new Event("disconnect"));
    });
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
