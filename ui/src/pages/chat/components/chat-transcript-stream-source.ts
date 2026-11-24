import { createMemo } from "solid-js";
import { createParkedProjection } from "../../../lib/reactive/parked-projection.ts";
import { createDocumentVisibility } from "../../../lib/reactive/platform.ts";
import {
  buildCachedChatItems,
  findLiveStreamIndex,
  getChatItemsGeneration,
} from "../chat-thread.ts";
import { prepareChatStreamRender } from "./chat-message-markdown-view.tsx";
import type { StreamGroupOptions } from "./chat-message-stream-view.tsx";
import { isVisibleChatStream } from "./chat-position-projection.ts";
import { projectThreadMediaMessages } from "./chat-thread-media-gallery.ts";

/** Keep row membership separate from the live text consumed by the bubble and open previews. */
export function createTranscriptStreamSource(
  input: Parameters<typeof buildCachedChatItems>[0],
  searchFiltering: boolean,
) {
  // The pane frame parks, but its live stream getter remains independently reactive.
  // The memo also owns the visibility lifecycle for imperative transcript callers.
  const visible = createMemo(createDocumentVisibility);
  const source = createParkedProjection(
    () => {
      const currentInput = { ...input };
      const items = buildCachedChatItems(currentInput);
      // The gallery retains this map; refresh its live slot without rebuilding rows.
      const threadMediaMessages = projectThreadMediaMessages(
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
        threadMediaMessages,
      };
    },
    () => visible()(),
  );
  const snapshot = createMemo(source, {
    equals: (previous, next) =>
      previous.items === next.items && previous.generation === next.generation,
  })();
  // Text updates belong to the mounted bubble. Only grouping or visible-marker
  // changes rerun the projection and virtual rows below.
  const liveIndex = findLiveStreamIndex(snapshot.items);
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
