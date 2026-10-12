import type { WorkGroupRenderItem } from "../chat-thread-grouping.ts";
import { getExpansionStateVersion } from "../chat-thread.ts";
import { renderWorkGroupBrowserTabPreviews } from "./chat-tool-cards.ts";
import { createTranscriptMemo } from "./chat-transcript-memo.ts";

const workPreviewCache =
  createTranscriptMemo<ReturnType<typeof renderWorkGroupBrowserTabPreviews>>();

/** Collapsed work previews follow the same session expansion and bubble presentation. */
export function projectTranscriptWorkPreviews(
  groups: readonly WorkGroupRenderItem[],
  options: Parameters<typeof renderWorkGroupBrowserTabPreviews>[1] & {
    expanded: Map<string, boolean>;
    bubbleMode?: boolean;
    latestBrowserTabsKey: string;
  },
) {
  return workPreviewCache(
    groups,
    [
      options.expanded,
      getExpansionStateVersion(options.expanded),
      options.sessionKey,
      options.latestBrowserTabsKey,
      options.bubbleMode,
    ],
    () =>
      renderWorkGroupBrowserTabPreviews(
        options.bubbleMode ? [] : groups.filter((item) => !options.expanded.get(item.key)),
        options,
      ),
  );
}
