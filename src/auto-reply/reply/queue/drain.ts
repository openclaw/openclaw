import { defaultRuntime } from "../../../runtime.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import {
  buildCollectPrompt,
  beginQueueDrain,
  buildQueueSummaryLine,
  buildQueueSummaryPrompt,
  clearQueueSummaryState,
  drainCollectQueueStep,
  drainNextQueueItem,
  hasCrossChannelItems,
  waitForQueueDebounce,
} from "../../../utils/queue-helpers.js";
import { applyDeferredMediaUnderstandingToQueuedRun } from "../followup-media.js";
import { isRoutableChannel } from "../route-reply.js";
import { FOLLOWUP_QUEUES, type FollowupQueueState } from "./state.js";
import type { FollowupRun } from "./types.js";

// Persists the most recent runFollowup callback per queue key so that
// enqueueFollowupRun can restart a drain that finished and deleted the queue.
const FOLLOWUP_DRAIN_CALLBACKS_KEY = Symbol.for("openclaw.followupDrainCallbacks");

const FOLLOWUP_RUN_CALLBACKS = resolveGlobalMap<string, (run: FollowupRun) => Promise<void>>(
  FOLLOWUP_DRAIN_CALLBACKS_KEY,
);

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

function clearFollowupQueueSummaryState(queue: FollowupQueueState): void {
  clearQueueSummaryState(queue);
  queue.summaryItems = [];
}

export async function applyDeferredMediaToQueuedRuns(items: FollowupRun[]): Promise<void> {
  for (const item of items) {
    await applyDeferredMediaUnderstandingToQueuedRun(item, { logLabel: "followup queue" });
  }
}

async function resolveSummaryLines(items: FollowupRun[]): Promise<string[]> {
  const summaryLines: string[] = [];
  for (const item of items) {
    await applyDeferredMediaUnderstandingToQueuedRun(item, { logLabel: "followup queue" });
    summaryLines.push(buildQueueSummaryLine(item.summaryLine?.trim() || item.prompt.trim()));
  }
  return summaryLines;
}

export async function buildMediaAwareQueueSummaryPrompt(params: {
  dropPolicy: FollowupQueueState["dropPolicy"];
  droppedCount: number;
  summaryLines: string[];
  summaryItems: FollowupRun[];
  noun: string;
}): Promise<string | undefined> {
  if (params.dropPolicy !== "summarize" || params.droppedCount <= 0) {
    return undefined;
  }
  const summaryLines =
    params.summaryItems.length > 0
      ? await resolveSummaryLines(params.summaryItems)
      : params.summaryLines;
  return buildQueueSummaryPrompt({
    state: {
      dropPolicy: params.dropPolicy,
      droppedCount: params.droppedCount,
      summaryLines: [...summaryLines],
    },
    noun: params.noun,
  });
}

export function scheduleFollowupDrain(
  key: string,
  runFollowup: (run: FollowupRun) => Promise<void>,
): void {
  const queue = beginQueueDrain(FOLLOWUP_QUEUES, key);
  if (!queue) {
    return;
  }
  // Cache callback only when a drain actually starts. Avoid keeping stale
  // callbacks around from finalize calls where no queue work is pending.
  FOLLOWUP_RUN_CALLBACKS.set(key, runFollowup);
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
            run: runFollowup,
          });
          if (collectDrainResult === "empty") {
            break;
          }
          if (collectDrainResult === "drained") {
            continue;
          }

          const items = queue.items.slice();
          await applyDeferredMediaToQueuedRuns(items);
          const summary = await buildMediaAwareQueueSummaryPrompt({
            dropPolicy: queue.dropPolicy,
            droppedCount: queue.droppedCount,
            summaryLines: queue.summaryLines,
            summaryItems: queue.summaryItems,
            noun: "message",
          });
          const run = items.at(-1)?.run ?? queue.lastRun;
          if (!run) {
            break;
          }

          const routing = resolveOriginRoutingMetadata(items);

          const prompt = buildCollectPrompt({
            title: "[Queued messages while agent was busy]",
            items,
            summary,
            renderItem: (item, idx) => `---\nQueued #${idx + 1}\n${item.prompt}`.trim(),
          });
          await runFollowup({
            prompt,
            run,
            enqueuedAt: Date.now(),
            ...routing,
          });
          queue.items.splice(0, items.length);
          if (summary) {
            clearFollowupQueueSummaryState(queue);
          }
          continue;
        }

        const summaryPrompt = await buildMediaAwareQueueSummaryPrompt({
          dropPolicy: queue.dropPolicy,
          droppedCount: queue.droppedCount,
          summaryLines: queue.summaryLines,
          summaryItems: queue.summaryItems,
          noun: "message",
        });
        if (summaryPrompt) {
          const run = queue.lastRun;
          if (!run) {
            break;
          }
          if (
            !(await drainNextQueueItem(queue.items, async (item) => {
              await runFollowup({
                prompt: summaryPrompt,
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
          clearFollowupQueueSummaryState(queue);
          continue;
        }

        if (!(await drainNextQueueItem(queue.items, runFollowup))) {
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
      } else {
        scheduleFollowupDrain(key, runFollowup);
      }
    }
  })();
}
