import { Show } from "solid-js";
import { createPositionRail, type PositionRailParams } from "./chat-position-rail-controller.ts";
import { ChatPositionRailView } from "./chat-position-rail-view.tsx";

export function ChatPositionRail(props: PositionRailParams) {
  const view = createPositionRail(props);
  return <Show when={view()}>{(current) => <ChatPositionRailView {...current()} />}</Show>;
}
