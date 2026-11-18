import { createMemo, onSettled, Show } from "solid-js";
import {
  AnnotationBar,
  AnnotationTooltip,
} from "../../../components/browser/annotation-controls.tsx";
import { AnnotationDrawing } from "../../../components/browser/annotation-drawing.ts";
import type { AnnotationStroke } from "../../../components/browser/browser-annotation.ts";
import {
  readBrowserInspectedNode,
  type BrowserInspectedNode,
} from "../../../components/browser/browser-client.ts";
import {
  browserPanelInspectHighlightRegion,
  browserPanelNormalizedPoint,
  dispatchCompositedBrowserAnnotation,
  paintBrowserPanelOverlay,
  type BrowserPanelView,
} from "../../../components/browser/browser-panel-surface.ts";
import { projectCallbackOwner } from "../../../lib/reactive/callback-owner.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createResizeObserver } from "../../../lib/reactive/observers.ts";
import type { WidgetCapture } from "./widget-export.ts";

export type WidgetAnnotationCapture = WidgetCapture & { image: HTMLImageElement };
/** Presents the captured rendered state; the live iframe stays mounted underneath. */
export function WidgetAnnotation(props: {
  capture: WidgetAnnotationCapture;
  title: string;
  docId: string;
  target: HTMLElement;
  onExit: () => void;
}) {
  const elements = createMemo(() =>
    props.capture.elements.flatMap((value) => {
      const node = readBrowserInspectedNode(value);
      return node && node.rect.width > 0 && node.rect.height > 0 ? [node] : [];
    }),
  );
  let stage!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  const { owner, view: projection } = projectCallbackOwner(
    (notify) => {
      const state: {
        strokes: AnnotationStroke[];
        selected: { node: BrowserInspectedNode; stroke: AnnotationStroke } | null;
        hover: BrowserInspectedNode | null;
        pointer: { x: number; y: number } | null;
        error: string;
      } = { strokes: [], selected: null, hover: null, pointer: null, error: "" };
      const view = (): BrowserPanelView => ({
        kind: "native",
        targetId: props.docId,
        dataUrl: props.capture.dataUrl,
        image: props.capture.image,
        url: new URL(
          `/__openclaw__/canvas/documents/${encodeURIComponent(props.docId)}/index.html`,
          location.origin,
        ).href,
        metrics: {
          cssWidth: props.capture.width || props.capture.image.naturalWidth,
          cssHeight: props.capture.height || props.capture.image.naturalHeight,
          title: props.title,
          url: "",
        },
      });
      const paint = () =>
        paintBrowserPanelOverlay(
          canvas,
          stage,
          state.strokes,
          browserPanelInspectHighlightRegion(view(), state.hover ?? state.selected?.node ?? null),
        );
      const drawing = new AnnotationDrawing({
        stage: () => stage,
        strokes: () => state.strokes,
        setStrokes: (strokes) => {
          state.strokes = strokes;
          if (state.selected && !strokes.includes(state.selected.stroke)) {
            state.selected = null;
          }
          notify();
        },
        paint,
      });
      const hover = (event: PointerEvent) => {
        const point = browserPanelNormalizedPoint(stage, event);
        state.pointer = point;
        const metrics = view().metrics!;
        // The map and image come from the same snapshot. Pick the deepest (smallest)
        // visible box, so moving widgets cannot change what a frozen mark refers to.
        state.hover = point
          ? (elements()
              .filter(
                ({ rect }) =>
                  point.x * metrics.cssWidth >= rect.x &&
                  point.x * metrics.cssWidth <= rect.x + rect.width &&
                  point.y * metrics.cssHeight >= rect.y &&
                  point.y * metrics.cssHeight <= rect.y + rect.height,
              )
              .toSorted((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0] ??
            null)
          : null;
        paint();
        notify();
      };
      return {
        state,
        drawing,
        paint,
        down(event: PointerEvent) {
          canvas.focus({ preventScroll: true });
          hover(event);
          drawing.down(event);
        },
        move(event: PointerEvent) {
          if (drawing.active) {
            drawing.move(event);
          } else {
            hover(event);
          }
        },
        up(event: PointerEvent) {
          if (!drawing.active) {
            return;
          }
          drawing.up(event);
          const stroke = state.strokes.at(-1);
          if (stroke?.points.length === 1 && state.hover) {
            state.selected = { node: state.hover, stroke };
          }
          state.hover = null;
          paint();
          notify();
        },
        leave() {
          state.hover = null;
          state.pointer = null;
          paint();
          notify();
        },
        add() {
          drawing.cancel();
          try {
            const selected = state.selected?.node ?? null;
            const result = dispatchCompositedBrowserAnnotation(
              view(),
              undefined,
              state.strokes,
              selected,
              browserPanelInspectHighlightRegion(view(), selected),
              props.target,
            );
            if (result === "accepted") {
              props.onExit();
            } else {
              state.error = t(
                result === "unhandled" ? "browser.noChatTarget" : "browser.annotationLimitReached",
              );
              notify();
            }
          } catch (error) {
            state.error = error instanceof Error ? error.message : String(error);
            notify();
          }
        },
      };
    },
    (value) => value.state,
  );
  const read = projection.read;
  createResizeObserver(
    () => (stage ? [stage] : []),
    () => owner.paint(),
  );
  onSettled(() => {
    owner.paint();
    canvas.focus({ preventScroll: true });
    return () => owner.drawing.cancel();
  });
  return (
    <div
      class="widget-annotation"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.onExit();
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
          event.preventDefault();
          owner.drawing.undo();
        }
      }}
    >
      <AnnotationBar
        hasMarks={read().strokes.length > 0}
        onUndo={() => owner.drawing.undo()}
        onClear={() => {
          owner.leave();
          owner.drawing.clear();
        }}
        onExit={() => props.onExit()}
        onAdd={() => owner.add()}
      />
      <Show when={read().error}>
        <div class="board-widget__error" role="alert">
          {read().error}
        </div>
      </Show>
      <div
        class="widget-annotation__stage"
        ref={(node) => {
          stage = node;
        }}
      >
        <img class="widget-annotation__image" src={props.capture.dataUrl} alt={props.title} />
        <canvas
          class="bp-overlay bp-overlay--annotate"
          tabindex="0"
          aria-label={t("browser.annotateHint")}
          ref={(node) => {
            canvas = node;
          }}
          onPointerDown={(event) => owner.down(event)}
          onPointerMove={(event) => owner.move(event)}
          onPointerUp={(event) => owner.up(event)}
          onPointerCancel={(event) => owner.drawing.up(event)}
          onLostPointerCapture={(event) => owner.drawing.up(event)}
          onPointerLeave={() => owner.leave()}
        />
        <AnnotationTooltip node={read().hover} pointer={read().pointer} />
      </div>
    </div>
  );
}
