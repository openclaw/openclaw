import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { readPreparedActivity } from "../../../lib/chat/tool-call-grouping.ts";
import { sumRunOutputTokens } from "../chat-progress.ts";
import { transcriptRunId } from "../chat-thread-run-identity.ts";
import { getChatItemsGeneration, type buildCachedChatItems } from "../chat-thread.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { createTranscriptMemo } from "./chat-transcript-memo.ts";

const workingIndicators = createTranscriptMemo<
  Extract<ChatItem, { kind: "reading-indicator" }> | undefined
>();
const activityGroups = createTranscriptMemo<string | undefined>();

export function projectTranscriptActivity(
  chatItems: ReturnType<typeof buildCachedChatItems>,
  props: Pick<ChatThreadProps, "runId" | "runActive" | "runUsageById">,
) {
  const generation = getChatItemsGeneration(chatItems);
  const workingIndicator = workingIndicators(chatItems, [generation], () =>
    chatItems.find((item) => item.kind === "reading-indicator"),
  );
  const activityRunId = workingIndicator?.runId ?? props.runId;
  const activityGroupKey = activityGroups(
    chatItems,
    [generation, activityRunId, props.runActive],
    () =>
      props.runActive && activityRunId
        ? chatItems.findLast(
            (item) =>
              item.kind === "group" &&
              item.messages.some(
                ({ message }) =>
                  transcriptRunId(message) === activityRunId &&
                  readPreparedActivity(message).some(
                    (activity) =>
                      !activity.hideFromChannelProgress && !activity.suppressChannelProgress,
                  ),
              ),
          )?.key
        : undefined,
  );
  // A run that resumed a handoff counts on from the runs before it. Its own
  // run id and first usage report may not have arrived yet.
  const earlierRunIds = workingIndicator?.request?.runIds ?? [];
  const runOutputTokens =
    sumRunOutputTokens(
      props.runUsageById,
      workingIndicator?.runId ? [...earlierRunIds, workingIndicator.runId] : [],
    ) ?? sumRunOutputTokens(props.runUsageById, earlierRunIds);
  return { workingIndicator, activityRunId, activityGroupKey, runOutputTokens };
}
