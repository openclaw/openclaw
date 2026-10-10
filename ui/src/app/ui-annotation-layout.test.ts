import { expect, it } from "vitest";
import { placeAnnotation } from "./ui-annotation-layout.ts";
it("keeps mixed waiting and resolved labels apart and inside the viewport", () => {
  const viewport = { width: 390, height: 844 };
  const occupied = [{ x: 12, y: 128, width: 300, height: 60 }];
  const waiting = placeAnnotation(null, { width: 300, height: 100 }, viewport, occupied);
  expect(waiting).not.toBeNull();
  if (!waiting) {
    throw new Error("missing placement");
  }
  expect(waiting.y + waiting.height <= 128 || waiting.y >= 188).toBe(true);
  expect(waiting.y + waiting.height).toBeLessThanOrEqual(viewport.height - 68);
  expect(waiting.x + waiting.width).toBeLessThanOrEqual(viewport.width - 12);
});
it("requests the scrollable compact presentation instead of overlapping or clipping", () => {
  expect(
    placeAnnotation(null, { width: 300, height: 200 }, { width: 390, height: 300 }, [
      { x: 12, y: 12, width: 366, height: 220 },
    ]),
  ).toBeNull();
  expect(
    placeAnnotation(null, { width: 300, height: 300 }, { width: 390, height: 300 }, []),
  ).toBeNull();
});
