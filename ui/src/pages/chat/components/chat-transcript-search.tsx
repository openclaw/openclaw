import { createMemo, lazy, Show } from "solid-js";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import type { TranscriptSearchState } from "./chat-transcript-search-state.ts";

const TranscriptSearchContent = lazy(() => import("./chat-transcript-search-content.tsx"), {
  export: "TranscriptSearchContent",
});

export type TranscriptSearchProps = {
  search: TranscriptSearchState;
  chat: Pick<ChatThreadProps, "historyPagination" | "transcriptVisible">;
};

export function TranscriptSearch(props: TranscriptSearchProps) {
  const source = createMemo(() => projectOwner(props.search, (owner) => owner.snapshot, Object.is));
  return (
    <Show when={source().read().open}>
      <ChatLazyBoundary>
        <TranscriptSearchContent
          search={props.search}
          chat={props.chat}
          query={source().read().query}
        />
      </ChatLazyBoundary>
    </Show>
  );
}
