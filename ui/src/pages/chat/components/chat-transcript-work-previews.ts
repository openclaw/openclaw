import type { WorkGroupRenderItem } from "../chat-thread-grouping.ts";
import { getExpansionStateVersion } from "../chat-thread.ts";
import { selectWorkGroupBrowserTabPreviews } from "./chat-tool-cards.ts";
import { createTranscriptMemo } from "./chat-transcript-memo.ts";

const workPreviewCache =
  createTranscriptMemo<ReturnType<typeof selectWorkGroupBrowserTabPreviews>>();

/** Collapsed work previews follow the same session expansion and bubble presentation. */
export function projectTranscriptWorkPreviews(
  groups: readonly WorkGroupRenderItem[],
  options: Parameters<typeof selectWorkGroupBrowserTabPreviews>[1] & {
    expanded: Map<string, boolean>;
    bubbleMode?: boolean;
  },
) {
  return workPreviewCache(
    groups,
    [
      options.expanded,
      getExpansionStateVersion(options.expanded),
      options.sessionKey,
      options.latestBrowserTabs,
      options.bubbleMode,
    ],
    () =>
      selectWorkGroupBrowserTabPreviews(
        options.bubbleMode ? [] : groups.filter((item) => !options.expanded.get(item.key)),
        options,
      ),
  );
}
