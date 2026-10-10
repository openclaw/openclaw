export type AnnotationBox = { x: number; y: number; width: number; height: number };
const annotationBoxesOverlap = (a: AnnotationBox, b: AnnotationBox) =>
  a.x < b.x + b.width + 12 &&
  a.x + a.width + 12 > b.x &&
  a.y < b.y + b.height + 12 &&
  a.y + a.height + 12 > b.y;
export function placeAnnotation(
  target: AnnotationBox | null,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  occupied: AnnotationBox[],
): AnnotationBox | null {
  const { width, height } = size;
  if (width > viewport.width - 24 || height > viewport.height - 80) {
    return null;
  }
  const clamp = (x: number, y: number): AnnotationBox => ({
    x: Math.max(12, Math.min(viewport.width - width - 12, x)),
    y: Math.max(12, Math.min(viewport.height - height - 68, y)),
    width,
    height,
  });
  const candidates: AnnotationBox[] = [];
  if (target) {
    const cx = target.x + target.width / 2,
      cy = target.y + target.height / 2;
    candidates.push(
      clamp(cx - width / 2, target.y + target.height + 92),
      clamp(cx - width / 2, target.y - height - 92),
      clamp(target.x - width - 100, cy - height / 2),
      clamp(target.x + target.width + 100, cy - height / 2),
    );
  }
  // Waiting labels use the same actual occupied rectangles as resolved labels.
  for (const y of [12, ...occupied.map((box) => box.y + box.height + 16)]) {
    for (const x of [
      12,
      viewport.width - width - 12,
      ...occupied.map((box) => box.x + box.width + 16),
    ]) {
      candidates.push(clamp(x, y));
    }
  }
  return (
    candidates.find(
      (box) =>
        (!target || !annotationBoxesOverlap(box, target)) &&
        !occupied.some((other) => annotationBoxesOverlap(box, other)),
    ) ?? null
  );
}
