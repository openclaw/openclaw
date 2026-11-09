import type { BoardWidgetCellProps } from "./board-widget-cell-options.ts";

export function handleBoardWidgetKeyDown(
  event: KeyboardEvent,
  props: BoardWidgetCellProps,
  run: (action: () => Promise<void>) => void,
) {
  if (
    event.target !== event.currentTarget ||
    props.canMutate === false ||
    props.pageChrome ||
    props.lobby
  ) {
    return;
  }
  const direction =
    event.key === "ArrowLeft"
      ? "left"
      : event.key === "ArrowRight"
        ? "right"
        : event.key === "ArrowUp"
          ? "up"
          : event.key === "ArrowDown"
            ? "down"
            : null;
  if (!direction) {
    return;
  }
  event.preventDefault();
  if (event.altKey) {
    run(() => props.callbacks!.nudge(props.widget!, direction));
  } else {
    props.callbacks!.focus(props.widget!, direction);
  }
}
