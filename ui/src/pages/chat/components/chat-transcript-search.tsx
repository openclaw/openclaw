import { createMemo, lazy, Show } from "solid-js";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import type { TranscriptSearchState } from "./chat-transcript-search-state.ts";

const TranscriptSearchContent = lazy(() => import("./chat-transcript-search-content.tsx"), {
  export: "TranscriptSearchContent",
});

export function TranscriptSearch(props: { search: TranscriptSearchState }) {
  const source = createMemo(() => projectOwner(props.search, (owner) => owner.snapshot, Object.is));
  return (
    <Show when={source().read().open}>
      <ChatLazyBoundary>
        <TranscriptSearchContent search={props.search} query={source().read().query} />
      </ChatLazyBoundary>
    </Show>
  );
}
