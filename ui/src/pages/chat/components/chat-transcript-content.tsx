import { BrowserTabPreviews } from "./chat-browser-tab-previews.tsx";
import type { BrowserTabPreview } from "./chat-tool-cards.ts";

export function TranscriptWorkPreviews(props: { previews: readonly BrowserTabPreview[] }) {
  return (
    <div class="chat-group tool chat-group--turn-block">
      <div class="chat-group-messages">
        <BrowserTabPreviews previews={props.previews} />
      </div>
    </div>
  );
}
