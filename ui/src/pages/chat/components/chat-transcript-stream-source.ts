import { createMemo } from "solid-js";
import {
  buildCachedChatItems,
  findLiveStreamIndex,
  getChatItemsGeneration,
} from "../chat-thread.ts";
import { prepareChatStreamRender } from "./chat-message-markdown-view.tsx";
import type { StreamGroupOptions } from "./chat-message-stream-view.tsx";
import { isVisibleChatStream } from "./chat-position-projection.ts";
import { projectTurnVideoMessages } from "./chat-turn-video-gallery.ts";

/** Keep row membership separate from the live text consumed by the bubble and open previews. */
export function createTranscriptStreamSource(
  input: Parameters<typeof buildCachedChatItems>[0],
  searchFiltering: boolean,
) {
  const source = createMemo(() => {
    const currentInput = { ...input };
    const items = buildCachedChatItems(currentInput);
    // The gallery retains this map; refresh its live slot without rebuilding rows.
    const turnVideoMessages = projectTurnVideoMessages(
      searchFiltering
        ? buildCachedChatItems(
            { ...currentInput, searchOpen: false, searchQuery: "", messageRecovery: undefined },
            "unfiltered",
          )
        : items,
    );
    return {
      items,
      generation: getChatItemsGeneration(items),
      turnVideoMessages,
    };
  });
  const structure = createMemo(source, {
    equals: (previous, next) =>
      previous.items === next.items && previous.generation === next.generation,
  });
  // Text updates belong to the mounted bubble. Only grouping or visible-marker
  // changes rerun the projection and virtual rows below.
  const snapshot = structure();
  const chatItems = snapshot.items;
  const liveIndex = findLiveStreamIndex(chatItems);
  const live = createMemo(() => {
    const candidate = source().items[liveIndex];
    const part = candidate?.kind === "stream" ? candidate : undefined;
    return { part, prepared: part ? prepareChatStreamRender(part) : undefined };
  });
  const liveVisibility = createMemo(() => {
    const part = live().part;
    return Boolean(part && isVisibleChatStream(part));
  });
  liveVisibility();
  const resolveLiveStream: NonNullable<StreamGroupOptions["resolveLiveStream"]> = (part) => {
    const current = live().part;
    return current?.key === part.key ? current : part;
  };
  return { snapshot, live, resolveLiveStream };
}
