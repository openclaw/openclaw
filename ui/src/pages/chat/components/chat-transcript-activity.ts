import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { readPreparedActivity } from "../../../lib/chat/tool-call-grouping.ts";
import { extractToolCardsCached, resolveToolCardOutcome } from "../../../lib/chat/tool-cards.ts";
import { sumRunOutputTokens } from "../chat-progress.ts";
import { transcriptRunId } from "../chat-thread-run-identity.ts";
import { getChatItemsGeneration, type buildCachedChatItems } from "../chat-thread.ts";
import { persistedSteerTargetRunId } from "../stream-causal-boundary.ts";
import type { StreamGroupPart } from "./chat-message-stream-view.tsx";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { createTranscriptMemo } from "./chat-transcript-memo.ts";
import type { TranscriptDependencyItem } from "./chat-transcript-render-guard.ts";

const workingIndicators = createTranscriptMemo<
  Extract<ChatItem, { kind: "reading-indicator" }> | undefined
>();
const activityGroups = createTranscriptMemo<{ key: string; running: boolean } | undefined>();

export function projectTranscriptActivity(
  chatItems: ReturnType<typeof buildCachedChatItems>,
  props: Pick<ChatThreadProps, "runId" | "runActive" | "runUsageById">,
) {
  const generation = getChatItemsGeneration(chatItems);
  const workingIndicator = workingIndicators(chatItems, [generation], () =>
    chatItems.find((item) => item.kind === "reading-indicator"),
  );
  const activityRunId = workingIndicator?.runId ?? props.runId;
  const activityGroup = activityGroups(
    chatItems,
    [generation, activityRunId, props.runActive],
    () => {
      // A steer does not finish the operation it addresses. A later narrative,
      // question, or notice still closes the activity segment.
      // The working indicator is status for the run, not another transcript action.
      // Queued inputs after it belong to later work and cannot settle this action.
      const workingIndex = workingIndicator ? chatItems.indexOf(workingIndicator) : -1;
      const group =
        props.runActive && activityRunId
          ? chatItems.findLast(
              (item, index) =>
                (workingIndex < 0 || index < workingIndex) &&
                item.kind !== "reading-indicator" &&
                !(
                  item.kind === "group" &&
                  item.role === "user" &&
                  item.messages.every(
                    ({ message }) => persistedSteerTargetRunId(message) === activityRunId,
                  )
                ),
            )
          : undefined;
      if (group?.kind !== "group") {
        return undefined;
      }
      const messages = group.messages.filter(
        ({ message }) => transcriptRunId(message) === activityRunId,
      );
      const calls = new Map(
        messages.flatMap(({ message }) =>
          readPreparedActivity(message).map(
            (item) => [item.toolCallId ?? item.itemId, item] as const,
          ),
        ),
      );
      const visible = [...calls.values()].filter(
        (item) => !item.hideFromChannelProgress && !item.suppressChannelProgress,
      );
      // A raw call precedes its prepared activity. Keep its owner eligible while
      // facts hydrate; an explicit empty projection still means hidden work.
      const rawCards = messages.flatMap(({ message }) =>
        Array.isArray(asNullableRecord(message)?.activity) ? [] : extractToolCardsCached(message),
      );
      if (visible.length === 0 && rawCards.length === 0) {
        return undefined;
      }
      return {
        key: group.key,
        running:
          visible.some((item) => item.status === "running") ||
          rawCards.some((card) => resolveToolCardOutcome(card, true) === "running"),
      };
    },
  );
  // A run that resumed a handoff counts on from the runs before it. Its own
  // run id and first usage report may not have arrived yet.
  const earlierRunIds = workingIndicator?.request?.runIds ?? [];
  const runOutputTokens =
    sumRunOutputTokens(
      props.runUsageById,
      workingIndicator?.runId ? [...earlierRunIds, workingIndicator.runId] : [],
    ) ?? sumRunOutputTokens(props.runUsageById, earlierRunIds);
  return {
    workingIndicator,
    activityRunId,
    activityGroupKey: activityGroup?.key ?? null,
    runningActivityGroupKey: activityGroup?.running ? activityGroup.key : undefined,
    runOutputTokens,
  };
}

/** Invalidate only the transcript rows that display changing run status. */
export function createLiveStatusSignature(
  workingUsageKey: string,
  runDurations: ReadonlyMap<string, number>,
  latestAssistantItemKey: string | null,
  continuations: ReadonlyMap<string, readonly StreamGroupPart[]>,
  searchFiltering: boolean,
  swarmSignature: (key: string) => string | undefined,
) {
  return (item: TranscriptDependencyItem): string => {
    if (item.kind === "reading-indicator") {
      return workingUsageKey;
    }
    if (item.kind === "stream-run") {
      return item.parts.some((part) => part.kind === "reading-indicator") ? workingUsageKey : "";
    }
    if (item.kind !== "group" && item.kind !== "agent-run-frame") {
      return "";
    }
    const duration = item.runId ? runDurations.get(item.runId) : undefined;
    const statusKey = `${duration ?? ""}|${item.key === latestAssistantItemKey ? "latest-assistant" : ""}`;
    if (item.kind === "agent-run-frame") {
      const hasWorkingIndicator = item.parts.some(
        (part) =>
          part.kind === "stream-run" &&
          part.parts.some((streamPart) => streamPart.kind === "reading-indicator"),
      );
      return `${hasWorkingIndicator ? workingUsageKey : ""}|${statusKey}|${swarmSignature(item.key) ?? ""}`;
    }
    const continuation = continuations.get(item.key);
    // Continuation options already participate in the shared render context.
    const continuationKey = continuation
      ? `${continuation.map((part) => part.key).join(" ")}${workingUsageKey}`
      : "";
    return `${continuationKey}|${statusKey}|${searchFiltering ? "search-result" : ""}`;
  };
}
