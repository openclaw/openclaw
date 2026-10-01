import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { readPreparedActivity } from "../../../lib/chat/tool-call-grouping.ts";
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
  const runOutputTokens = workingIndicator?.runId
    ? (props.runUsageById?.get(workingIndicator.runId)?.outputTokens ?? null)
    : null;
  return { workingIndicator, activityRunId, activityGroupKey, runOutputTokens };
}
