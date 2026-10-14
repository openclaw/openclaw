import type { IconData } from "./icon-data-types.ts";
import { NEUTRAL_MARK as MARK } from "./neutral-mark-geometry.ts";

export const neutralMarkData: IconData = {
  attributes: {
    viewBox: MARK.viewBox,
    width: "100%",
    height: "100%",
    fill: "none",
    "aria-hidden": "true",
  },
  children: [
    [
      "rect",
      {
        x: MARK.inset,
        y: MARK.inset,
        width: MARK.size,
        height: MARK.size,
        rx: MARK.radius,
        style: "fill: var(--primary); stroke: none",
      },
    ],
    [
      "path",
      {
        d: MARK.glyph,
        style: "fill: none; stroke: var(--primary-foreground)",
        "stroke-width": MARK.strokeWidth,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
    ],
  ],
};
