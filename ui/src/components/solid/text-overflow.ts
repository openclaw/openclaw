import { createLayoutMeasurement } from "../../lib/reactive/layout-measurement.ts";
import "./text-overflow.css";

/** Fade only clipped text; callers retain the complete value and its layout. */
export function createTextOverflow(content: () => unknown) {
  let element: HTMLElement | undefined;
  createLayoutMeasurement(
    content,
    () => {
      if (!element) {
        return undefined;
      }
      const target = element;
      const overflow = target.scrollWidth > target.clientWidth + 1 ? "inline" : "none";
      return () => {
        target.dataset.textOverflow = overflow;
      };
    },
    { targets: () => (element ? [element] : []), fonts: true },
  );
  return (target: HTMLElement) => {
    element = target;
  };
}
