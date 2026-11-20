import type { AnnotationStroke } from "./browser-annotation.ts";
import { browserPanelNormalizedPoint } from "./browser-panel-surface.ts";

/** One pointer owns a stroke across both browser and widget capture surfaces. */
export class AnnotationDrawing {
  private gesture: { pointerId: number; target: HTMLElement; stroke: AnnotationStroke } | null =
    null;

  constructor(
    private readonly host: {
      stage: () => HTMLElement | null;
      strokes: () => AnnotationStroke[];
      setStrokes: (strokes: AnnotationStroke[]) => void;
      paint: () => void;
    },
  ) {}

  get active(): boolean {
    return this.gesture !== null;
  }

  down(event: PointerEvent): void {
    if (event.button !== 0 || this.gesture) {
      return;
    }
    const point = browserPanelNormalizedPoint(this.host.stage(), event);
    const target =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget
        : event.target instanceof HTMLElement
          ? event.target
          : null;
    if (!point || !target) {
      return;
    }
    event.preventDefault();
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // A detached/synthetic canvas can refuse capture; pointer ownership still applies.
    }
    const stroke = { points: [point] };
    this.gesture = { pointerId: event.pointerId, target, stroke };
    this.host.setStrokes([...this.host.strokes(), stroke]);
    this.host.paint();
  }

  move(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture || gesture.pointerId !== event.pointerId) {
      return;
    }
    const point = browserPanelNormalizedPoint(this.host.stage(), event);
    if (point) {
      gesture.stroke.points.push(point);
      this.host.paint();
    }
  }

  up(event: PointerEvent): void {
    if (this.gesture?.pointerId === event.pointerId) {
      this.gesture = null;
    }
  }

  cancel(): void {
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) {
      return;
    }
    try {
      if (gesture.target.hasPointerCapture(gesture.pointerId)) {
        gesture.target.releasePointerCapture(gesture.pointerId);
      }
    } catch {
      /* Capture may already be gone after a canvas detach. */
    }
  }

  undo(): void {
    this.cancel();
    this.host.setStrokes(this.host.strokes().slice(0, -1));
    this.host.paint();
  }

  clear(): void {
    this.cancel();
    this.host.setStrokes([]);
    this.host.paint();
  }
}
