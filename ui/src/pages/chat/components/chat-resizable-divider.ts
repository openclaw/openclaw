import { html, nothing } from "lit";

export function renderChatResizableDivider(props: {
  className?: string;
  label: string;
  maxRatio?: number;
  measureRatio?: () => number;
  measureSize?: () => number;
  minRatio?: number;
  onDragover?: (event: DragEvent) => void;
  onDrop?: (event: DragEvent) => void;
  onResize: (event: CustomEvent<{ splitRatio: number }>) => void;
  orientation: "horizontal" | "vertical";
  splitRatio: number;
}) {
  return html`<resizable-divider
    class=${props.className ?? nothing}
    .splitRatio=${props.splitRatio}
    .minRatio=${props.minRatio ?? 0.4}
    .maxRatio=${props.maxRatio ?? 0.7}
    .measureRatio=${props.measureRatio}
    .measureSize=${props.measureSize}
    .label=${props.label}
    .orientation=${props.orientation}
    @dragover=${props.onDragover ?? (() => {})}
    @drop=${props.onDrop ?? (() => {})}
    @resize=${props.onResize}
  ></resizable-divider>`;
}
