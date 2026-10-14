import { html, nothing } from "lit";
import type { ChatSourcePreview } from "../../../lib/chat/source-previews.ts";
import type { LinkFaviconFetcher } from "../link-favicon-cache.ts";
import "./chat-source-previews.tsx";

export function renderChatSourcePreviews(
  sources: readonly ChatSourcePreview[],
  fetchFavicon?: LinkFaviconFetcher,
) {
  return sources.length > 0
    ? html`<openclaw-chat-sources
        .sources=${sources}
        .fetchFavicon=${fetchFavicon}
      ></openclaw-chat-sources>`
    : nothing;
}
