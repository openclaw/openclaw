import { createMemo, createSignal, flush, onCleanup, Show } from "solid-js";
import {
  ChatPositionRailController,
  type PositionRailParams,
} from "./chat-position-rail-controller.ts";
import { ChatPositionRailView } from "./chat-position-rail-view.tsx";

export function ChatPositionRail(props: PositionRailParams) {
  const [revision, setRevision] = createSignal(0);
  const controller = new ChatPositionRailController(() => {
    setRevision((value) => value + 1);
    // Keyboard navigation commits the retained target before focusing it.
    flush();
  });
  const view = createMemo(() => {
    revision();
    return controller.view(props);
  });
  onCleanup(() => controller.disconnect());
  return <Show when={view()}>{(current) => <ChatPositionRailView {...current()} />}</Show>;
}
