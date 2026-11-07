/** Point in normalized [0..1] coordinates of the captured image. */
type AnnotationPoint = { x: number; y: number };

export type AnnotationStroke = { points: AnnotationPoint[] };

/** Axis-aligned box in normalized [0..1] image coordinates. */
export type AnnotationRegion = { x: number; y: number; width: number; height: number };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const ANNOTATION_STROKE_COLOR = "#e0442d";

/**
 * Draws the strokes (and optional element highlight, both in normalized
 * image coordinates) onto a 2D context sized to the capture resolution.
 * The painter has no browser-panel, translation, or prompt side effects.
 */
export function paintAnnotations(
  ctx: CanvasRenderingContext2D,
  params: {
    width: number;
    height: number;
    strokes: AnnotationStroke[];
    highlight?: AnnotationRegion | null;
  },
): void {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = ANNOTATION_STROKE_COLOR;
  ctx.lineWidth = Math.max(4, Math.round(params.width * 0.005));
  for (const stroke of params.strokes) {
    if (stroke.points.length === 0) {
      continue;
    }
    ctx.beginPath();
    stroke.points.forEach((point, index) => {
      const x = clamp01(point.x) * params.width;
      const y = clamp01(point.y) * params.height;
      if (index === 0) {
        ctx.moveTo(x, y);
        if (stroke.points.length === 1) {
          // A click without movement still deserves a visible dot.
          ctx.lineTo(x + 0.1, y);
        }
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.stroke();
  }
  if (params.highlight) {
    const { x, y, width, height } = params.highlight;
    ctx.strokeRect(
      clamp01(x) * params.width,
      clamp01(y) * params.height,
      Math.max(2, width * params.width),
      Math.max(2, height * params.height),
    );
  }
}
