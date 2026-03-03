import { defaultRuntime } from "../../../runtime.js";
import {
  buildCollectPrompt,
  beginQueueDrain,
  clearQueueSummaryState,
  drainNextQueueItem,
  previewQueueSummaryPrompt,
  waitForQueueDebounce,
} from "../../../utils/queue-helpers.js";
import { isRoutableChannel } from "../route-reply.js";
import { FOLLOWUP_QUEUES } from "./state.js";
import type { FollowupRun } from "./types.js";

// Persists the most recent runFollowup callback per queue key so that
// enqueueFollowupRun can restart a drain that finished and deleted the queue.
const FOLLOWUP_RUN_CALLBACKS = new Map<string, (run: FollowupRun) => Promise<void>>();

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
  | "relayMode"
  | "relayOutput"
  | "originatingChannel"
  | "originatingTo"
  | "originatingAccountId"
  | "originatingThreadId"
>;

function resolveOriginRoutingMetadata(items: FollowupRun[]): OriginRoutingMetadata {
  // Pick a single authoritative item for relay fields so we never mix
  // relayMode from one queued item with relayOutput from another.
  const relayItem = items.find((item) => item.relayMode);
  return {
    relayMode: relayItem?.relayMode,
    relayOutput: relayItem?.relayOutput,
    originatingChannel:
      relayItem?.originatingChannel ??
      items.find((item) => item.originatingChannel)?.originatingChannel,
    originatingTo:
      relayItem?.originatingTo ?? items.find((item) => item.originatingTo)?.originatingTo,
    originatingAccountId:
      relayItem?.originatingAccountId ??
      items.find((item) => item.originatingAccountId)?.originatingAccountId,
    // Support both number (Telegram topic) and string (Slack thread_ts) thread IDs.
    originatingThreadId:
      relayItem?.originatingThreadId ??
      items.find((item) => item.originatingThreadId != null && item.originatingThreadId !== "")
        ?.originatingThreadId,
  };
}

function resolveCrossChannelKey(item: FollowupRun): { cross?: true; key?: string } {
  if (item.relayMode === "read-only") {
    const channel = item.relayOutput?.channel;
    const to = item.relayOutput?.to;
    const accountId = item.relayOutput?.accountId;
    const threadId = item.relayOutput?.threadId;
    if (!channel && !to && !accountId && (threadId == null || threadId === "")) {
      return { cross: true };
    }
    if (!isRoutableChannel(channel) || !to) {
      return { cross: true };
    }
    const threadKey = threadId != null && threadId !== "" ? String(threadId) : "";
    return {
      key: ["relay", channel, to, accountId || "", threadKey].join("|"),
    };
  }

  const { originatingChannel: channel, originatingTo: to, originatingAccountId: accountId } = item;
  const threadId = item.originatingThreadId;
  if (!channel && !to && !accountId && (threadId == null || threadId === "")) {
    return {
      key: ["origin", "", "", "", ""].join("|"),
    };
  }
  if (!isRoutableChannel(channel) || !to) {
    return { cross: true };
  }
  // Support both number (Telegram topic IDs) and string (Slack thread_ts) thread IDs.
  const threadKey = threadId != null && threadId !== "" ? String(threadId) : "";
  return {
    key: ["origin", channel, to, accountId || "", threadKey].join("|"),
  };
}

type FollowupCollectGroup = {
  key: string;
  items: FollowupRun[];
  collectable: boolean;
};

function resolveCollectGroups(items: FollowupRun[]): FollowupCollectGroup[] {
  const groups: FollowupCollectGroup[] = [];
  let currentGroup: FollowupCollectGroup | undefined;
  for (const [index, item] of items.entries()) {
    const resolved = resolveCrossChannelKey(item);
    const collectable = Boolean(resolved.key && !resolved.cross);
    const key = collectable
      ? (resolved.key ?? `single|${index}|${item.enqueuedAt}`)
      : `single|${index}|${item.enqueuedAt}`;

    // Preserve FIFO across destinations by only collecting contiguous runs.
    if (currentGroup && currentGroup.collectable && collectable && currentGroup.key === key) {
      currentGroup.items.push(item);
      continue;
    }
    if (currentGroup) {
      groups.push(currentGroup);
    }
    currentGroup = { key, items: [item], collectable };
  }
  if (currentGroup) {
    groups.push(currentGroup);
  }
  return groups;
}

function removeDrainedItems(items: FollowupRun[], drained: FollowupRun[]) {
  if (drained.length === 0) {
    return;
  }
  const drainedSet = new Set(drained);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (drainedSet.has(items[index])) {
      items.splice(index, 1);
    }
  }
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
      // Snapshot routing metadata while items exist so overflow-only
      // summary followups still carry relay/origin routing context.
      let lastKnownRouting: OriginRoutingMetadata | undefined;
      while (queue.items.length > 0 || queue.droppedCount > 0) {
        await waitForQueueDebounce(queue);
        if (queue.items.length > 0) {
          lastKnownRouting = resolveOriginRoutingMetadata(queue.items);
        }
        if (queue.mode === "collect") {
          const groups = resolveCollectGroups(queue.items);
          const currentGroup = groups[0];
          if (!currentGroup) {
            // Items exhausted but overflow summary may be pending (droppedCount > 0).
            // Emit summary to prevent infinite re-schedule — matches main's batch
            // fallthrough that naturally handles empty items + pending summary.
            const summary = previewQueueSummaryPrompt({ state: queue, noun: "message" });
            if (!summary) {
              break;
            }
            const run = queue.lastRun;
            if (!run) {
              break;
            }
            const prompt = buildCollectPrompt({
              title: "[Queued messages while agent was busy]",
              items: [] as FollowupRun[],
              summary,
              renderItem: (item, idx) => `---\nQueued #${idx + 1}\n${item.prompt}`.trim(),
            });
            await runFollowup({
              prompt,
              run,
              enqueuedAt: Date.now(),
              ...lastKnownRouting,
            });
            clearQueueSummaryState(queue);
            continue;
          }

          const summary = previewQueueSummaryPrompt({ state: queue, noun: "message" });
          const shouldCollectGroup = currentGroup.collectable && currentGroup.items.length > 1;
          if (!shouldCollectGroup && !summary) {
            if (!(await drainNextQueueItem(queue.items, runFollowup))) {
              break;
            }
            continue;
          }

          const run = currentGroup.items.at(-1)?.run ?? queue.lastRun;
          if (!run) {
            break;
          }

          const routing = resolveOriginRoutingMetadata(currentGroup.items);

          const prompt = buildCollectPrompt({
            title: "[Queued messages while agent was busy]",
            items: currentGroup.items,
            summary,
            renderItem: (item, idx) => `---\nQueued #${idx + 1}\n${item.prompt}`.trim(),
          });
          await runFollowup({
            prompt,
            run,
            enqueuedAt: Date.now(),
            ...routing,
          });
          removeDrainedItems(queue.items, currentGroup.items);
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
              await runFollowup({
                prompt: summaryPrompt,
                run,
                enqueuedAt: Date.now(),
                originatingChannel: item.originatingChannel,
                originatingTo: item.originatingTo,
                originatingAccountId: item.originatingAccountId,
                originatingThreadId: item.originatingThreadId,
                relayMode: item.relayMode,
                relayOutput: item.relayOutput,
              });
            }))
          ) {
            break;
          }
          clearQueueSummaryState(queue);
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
