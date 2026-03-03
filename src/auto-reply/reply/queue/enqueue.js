import { applyQueueDropPolicy, shouldSkipQueueItem } from "../../../utils/queue-helpers.js";
import { getExistingFollowupQueue, getFollowupQueue } from "./state.js";
function isRunAlreadyQueued(run, items, allowPromptFallback = false) {
    const hasSameRouting = (item) => item.originatingChannel === run.originatingChannel &&
        item.originatingTo === run.originatingTo &&
        item.originatingAccountId === run.originatingAccountId &&
        item.originatingThreadId === run.originatingThreadId;
    const messageId = run.messageId?.trim();
    if (messageId) {
        return items.some((item) => item.messageId?.trim() === messageId && hasSameRouting(item));
    }
    if (!allowPromptFallback) {
        return false;
    }
    return items.some((item) => item.prompt === run.prompt && hasSameRouting(item));
}
export function enqueueFollowupRun(key, run, settings, dedupeMode = "message-id") {
    const queue = getFollowupQueue(key, settings);
    const dedupe = dedupeMode === "none"
        ? undefined
        : (item, items) => isRunAlreadyQueued(item, items, dedupeMode === "prompt");
    // Deduplicate: skip if the same message is already queued.
    if (shouldSkipQueueItem({ item: run, items: queue.items, dedupe })) {
        return false;
    }
    queue.lastEnqueuedAt = Date.now();
    queue.lastRun = run.run;
    const shouldEnqueue = applyQueueDropPolicy({
        queue,
        summarize: (item) => item.summaryLine?.trim() || item.prompt.trim(),
    });
    if (!shouldEnqueue) {
        return false;
    }
    queue.items.push(run);
    return true;
}
export function getFollowupQueueDepth(key) {
    const queue = getExistingFollowupQueue(key);
    if (!queue) {
        return 0;
    }
    return queue.items.length;
}
