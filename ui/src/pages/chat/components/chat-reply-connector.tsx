import { onSettled, useContext } from "solid-js";
import { createResizeObserver } from "../../../lib/reactive/observers.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";

export type ReplyConnectorElements = {
  group?: HTMLElement;
  row?: HTMLElement;
  label?: HTMLElement;
  avatar?: HTMLElement;
  messages?: HTMLElement;
};

/** One observer per connector; updates redraw without replacing the SVG. */
export function ReplyConnector(props: { elements: ReplyConnectorElements }) {
  const presented = useContext(ContentPresentation);
  let element: SVGSVGElement;
  let path: SVGPathElement;
  const draw = () => {
    const { group, row, label, avatar } = props.elements;
    if (!presented() || !element.isConnected || !group || !row || !label || !avatar?.isConnected) {
      return;
    }
    const bounds = group.getBoundingClientRect();
    const identity = avatar.getBoundingClientRect();
    const text = label.getBoundingClientRect();
    const startX = identity.left + identity.width / 2 - bounds.left;
    const startY = identity.top - bounds.top;
    const direction = getComputedStyle(group).direction === "rtl" ? -1 : 1;
    const rowBounds = row.getBoundingClientRect();
    const endX = (direction === 1 ? rowBounds.left : rowBounds.right) - bounds.left - direction * 5;
    const endY = text.top + text.height / 2 - bounds.top;
    element.setAttribute("width", String(bounds.width));
    element.setAttribute("height", String(bounds.height));
    path.setAttribute(
      "d",
      `M ${startX} ${startY} V ${endY + 7} Q ${startX} ${endY} ${startX + direction * 7} ${endY} H ${endX}`,
    );
  };
  onSettled(draw);
  createResizeObserver(
    () =>
      presented()
        ? [props.elements.group, props.elements.messages].filter((target): target is HTMLElement =>
            Boolean(target),
          )
        : [],
    draw,
  );
  return (
    <svg ref={(node) => (element = node)} class="chat-reply-connector" aria-hidden="true">
      <path
        ref={(node) => (path = node)}
        fill="none"
        stroke="currentColor"
        stroke-width="1"
        stroke-linecap="round"
      />
    </svg>
  );
}
