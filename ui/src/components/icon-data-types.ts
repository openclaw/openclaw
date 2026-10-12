export type IconAttributes = Readonly<{
  viewBox?: string;
  fill?: string;
  stroke?: string;
  "stroke-width"?: string | number;
  "stroke-linecap"?: "butt" | "round" | "square" | "inherit";
  "stroke-linejoin"?: "miter" | "round" | "bevel" | "inherit";
  style?: string;
  class?: string;
  width?: string | number;
  height?: string | number;
  "aria-hidden"?: "true" | "false";
  d?: string;
  x?: string | number;
  y?: string | number;
  rx?: string | number;
  ry?: string | number;
  cx?: string | number;
  cy?: string | number;
  r?: string | number;
  x1?: string | number;
  x2?: string | number;
  y1?: string | number;
  y2?: string | number;
  points?: string;
  id?: string;
  offset?: string | number;
}>;

export type IconNode = readonly [
  tag:
    | "path"
    | "rect"
    | "circle"
    | "line"
    | "polyline"
    | "polygon"
    | "defs"
    | "linearGradient"
    | "stop",
  attributes: IconAttributes,
  children?: readonly IconNode[],
];
export type IconData = {
  readonly attributes: IconAttributes;
  readonly children: readonly IconNode[];
};

export function strokeIconData(children: readonly IconNode[]): IconData {
  return {
    attributes: {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    },
    children,
  };
}
