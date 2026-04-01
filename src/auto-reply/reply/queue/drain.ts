import { defaultRuntime } from "../../../runtime.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import { renderDeferredBatch } from "../../../utils/deferred-render.js";
import {
  beginQueueDrain,
  clearQueueSummaryState,
  drainCollectQueueStep,
  drainNextQueueItem,
  hasCrossChannelItems,
  previewQueueSummaryPrompt,
  waitForQueueDebounce,
} from "../../../utils/queue-helpers.js";
import { isRoutableChannel } from "../route-reply.js";
import { FOLLOWUP_QUEUES } from "./state.js";
import { type FollowupRun } from "./types.js";

// Persists the most recent runFollowup callback per queue key so that
// enqueueFollowupRun can restart a drain that finished and deleted the queue.
const FOLLOWUP_DRAIN_CALLBACKS_KEY = Symbol.for("openclaw.followupDrainCallbacks");

const FOLLOWUP_RUN_CALLBACKS = resolveGlobalMap<string, (run: FollowupRun) => Promise<void>>(
  FOLLOWUP_DRAIN_CALLBACKS_KEY,
);

export function rememberFollowupDrainCallback(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
): void {
  FOLLOWUP_RUN_CALLBACKS.set(key, runFollowup);
}

export function clearFollowupDrainCallback(key: string): void {
  FOLLOWUP_RUN_CALLBACKS.delete(key);
}

/** Restart the drain for `key` if it is currently idle, using the stored callback. */
export function kickFollowupDrainIfIdle(key: string): void {
  const cb = FOLLOWUP_RUN_CALLBACKS.get(key);
  if (!cb) {
    return;
  }
  scheduleFollowupDrain(key, cb);
}

type OriginRoutingMetadata = Pick<
  FollowupRun,
  "originatingChannel" | "originatingTo" | "originatingAccountId" | "originatingThreadId"
>;

function resolveOriginRoutingMetadata(items: FollowupRun[]): OriginRoutingMetadata {
  return {
    originatingChannel: items.find((item) => item.originatingChannel)?.originatingChannel,
    originatingTo: items.find((item) => item.originatingTo)?.originatingTo,
    originatingAccountId: items.find((item) => item.originatingAccountId)?.originatingAccountId,
    // Support both number (Telegram topic) and string (Slack thread_ts) thread IDs.
    originatingThreadId: items.find(
      (item) => item.originatingThreadId != null && item.originatingThreadId !== "",
    )?.originatingThreadId,
  };
}

function resolveCrossChannelKey(item: FollowupRun): { cross?: true; key?: string } {
  const { originatingChannel: channel, originatingTo: to, originatingAccountId: accountId } = item;
  const threadId = item.originatingThreadId;
  if (!channel && !to && !accountId && (threadId == null || threadId === "")) {
    return {};
  }
  if (!isRoutableChannel(channel) || !to) {
    return { cross: true };
  }
  // Support both number (Telegram topic IDs) and string (Slack thread_ts) thread IDs.
  const threadKey = threadId != null && threadId !== "" ? String(threadId) : "";
  return {
    key: [channel, to, accountId || "", threadKey].join("|"),
  };
}

export function scheduleFollowupDrain(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
): void {
  const queue = beginQueueDrain(FOLLOWUP_QUEUES, key);
  if (!queue) {
    return;
  }
  const effectiveRunFollowup = FOLLOWUP_RUN_CALLBACKS.get(key) ?? runFollowup;
  // Cache callback only when a drain actually starts. Avoid keeping stale
  // callbacks around from finalize calls where no queue work is pending.
  rememberFollowupDrainCallback(key, effectiveRunFollowup);
  void (async () => {
    try {
      const collectState = { forceIndividualCollect: false };
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        await waitForQueueDebounce(queue);
        if (queue.mode === "collect") {
          // Once the batch is mixed, never collect again within this drain.
          // Prevents “collect after shift” collapsing different targets.
          //
          // Debug: `pnpm test src/auto-reply/reply/reply-flow.test.ts`
          // Check if messages span multiple channels.
          // If so, process individually to preserve per-message routing.
          const isCrossChannel = hasCrossChannelItems(queue.items, resolveCrossChannelKey);

          const collectDrainResult = await drainCollectQueueStep({
            collectState,
            isCrossChannel,
            items: queue.items,
            run: effectiveRunFollowup,
          });
          if (collectDrainResult === "empty") {
            break;
          }
          if (collectDrainResult === "drained") {
            continue;
          }

          const items = queue.items.slice();
          const summary = previewQueueSummaryPrompt({ state: queue, noun: "message" });
          const run = items.at(-1)?.run ?? queue.lastRun;
          if (!run) {
            break;
          }

          const routing = resolveOriginRoutingMetadata(items);

          const renderableItems = items
            .map((item) => item.display)
            .filter((item): item is NonNullable<typeof item> => Boolean(item));
          const canBatchRender = renderableItems.length === items.length;

          if (!canBatchRender) {
            if (summary) {
              const summaryTarget = items[0];
              if (!summaryTarget) {
                break;
              }
              await effectiveRunFollowup({
                execution: { visibility: "internal", agentPrompt: summary },
                display: { visibility: "user-visible", text: summary },
                run,
                enqueuedAt: Date.now(),
                originatingChannel: summaryTarget.originatingChannel,
                originatingTo: summaryTarget.originatingTo,
                originatingAccountId: summaryTarget.originatingAccountId,
                originatingThreadId: summaryTarget.originatingThreadId,
                originatingChatType: summaryTarget.originatingChatType,
              });
              clearQueueSummaryState(queue);
            }
            while (queue.items.length > 0) {
              if (!(await drainNextQueueItem(queue.items, effectiveRunFollowup))) {
                break;
              }
            }
            continue;
          }

          let prompt: string;
          try {
            prompt = renderDeferredBatch({
              title: "[Queued messages while agent was busy]",
              items: renderableItems,
              summary,
            });
          } catch (err) {
            defaultRuntime.error?.(
              `collect-mode deferred batch render failed for ${key}; falling back to individual drain: ${String(err)}`,
            );
            if (summary) {
              const summaryTarget = items[0];
              if (!summaryTarget) {
                break;
              }
              await effectiveRunFollowup({
                execution: { visibility: "internal", agentPrompt: summary },
                display: { visibility: "user-visible", text: summary },
                run,
                enqueuedAt: Date.now(),
                originatingChannel: summaryTarget.originatingChannel,
                originatingTo: summaryTarget.originatingTo,
                originatingAccountId: summaryTarget.originatingAccountId,
                originatingThreadId: summaryTarget.originatingThreadId,
                originatingChatType: summaryTarget.originatingChatType,
              });
              clearQueueSummaryState(queue);
            }
            collectState.forceIndividualCollect = true;
            continue;
          }

          await effectiveRunFollowup({
            execution: { visibility: "internal", agentPrompt: prompt },
            display: { visibility: "user-visible", text: prompt },
            run,
            enqueuedAt: Date.now(),
            ...routing,
          });
          queue.items.splice(0, items.length);
          if (summary) {
            clearQueueSummaryState(queue);
          }
          continue;
        }

        const summaryPrompt = previewQueueSummaryPrompt({ state: queue, noun: "message" });
        if (summaryPrompt) {
          const run = queue.lastRun;
          if (!run) {
            break;
          }
          if (
            !(await drainNextQueueItem(queue.items, async (item) => {
              await effectiveRunFollowup({
                execution: { visibility: "internal", agentPrompt: summaryPrompt },
                display: { visibility: "user-visible", text: summaryPrompt },
                run,
                enqueuedAt: Date.now(),
                originatingChannel: item.originatingChannel,
                originatingTo: item.originatingTo,
                originatingAccountId: item.originatingAccountId,
                originatingThreadId: item.originatingThreadId,
              });
            }))
          ) {
            break;
          }
          clearQueueSummaryState(queue);
          continue;
        }

        if (!(await drainNextQueueItem(queue.items, effectiveRunFollowup))) {
          break;
        }
      }
    } catch (err) {
      queue.lastEnqueuedAt = Date.now();
      defaultRuntime.error?.(`followup queue drain failed for ${key}: ${String(err)}`);
    } finally {
      queue.draining = false;
      if (queue.items.length === 0 && queue.droppedCount === 0) {
        FOLLOWUP_QUEUES.delete(key);
        clearFollowupDrainCallback(key);
      } else {
        scheduleFollowupDrain(key, effectiveRunFollowup);
      }
    }
  })();
}
