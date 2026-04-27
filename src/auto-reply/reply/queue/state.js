import { resolveGlobalMap } from "../../../shared/global-singleton.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { applyQueueRuntimeSettings } from "../../../utils/queue-helpers.js";
export const DEFAULT_QUEUE_DEBOUNCE_MS = 1000;
export const DEFAULT_QUEUE_CAP = 20;
export const DEFAULT_QUEUE_DROP = "summarize";
/**
 * Share followup queues across bundled chunks so busy-session enqueue/drain
 * logic observes one queue registry per process.
 */
const FOLLOWUP_QUEUES_KEY = Symbol.for("openclaw.followupQueues");
export const FOLLOWUP_QUEUES = resolveGlobalMap(FOLLOWUP_QUEUES_KEY);
export function getExistingFollowupQueue(key) {
    const cleaned = key.trim();
    if (!cleaned) {
        return undefined;
    }
    return FOLLOWUP_QUEUES.get(cleaned);
}
export function getFollowupQueue(key, settings) {
    const existing = FOLLOWUP_QUEUES.get(key);
    if (existing) {
        applyQueueRuntimeSettings({
            target: existing,
            settings,
        });
        return existing;
    }
    const created = {
        items: [],
        draining: false,
        lastEnqueuedAt: 0,
        mode: settings.mode,
        debounceMs: typeof settings.debounceMs === "number"
            ? Math.max(0, settings.debounceMs)
            : DEFAULT_QUEUE_DEBOUNCE_MS,
        cap: typeof settings.cap === "number" && settings.cap > 0
            ? Math.floor(settings.cap)
            : DEFAULT_QUEUE_CAP,
        dropPolicy: settings.dropPolicy ?? DEFAULT_QUEUE_DROP,
        droppedCount: 0,
        summaryLines: [],
    };
    applyQueueRuntimeSettings({
        target: created,
        settings,
    });
    FOLLOWUP_QUEUES.set(key, created);
    return created;
}
export function clearFollowupQueue(key) {
    const cleaned = key.trim();
    const queue = getExistingFollowupQueue(cleaned);
    if (!queue) {
        return 0;
    }
    const cleared = queue.items.length + queue.droppedCount;
    queue.items.length = 0;
    queue.droppedCount = 0;
    queue.summaryLines = [];
    queue.lastRun = undefined;
    queue.lastEnqueuedAt = 0;
    FOLLOWUP_QUEUES.delete(cleaned);
    return cleared;
}
export function refreshQueuedFollowupSession(params) {
    const cleaned = params.key.trim();
    if (!cleaned) {
        return;
    }
    const queue = getExistingFollowupQueue(cleaned);
    if (!queue) {
        return;
    }
    const shouldRewriteSession = Boolean(params.previousSessionId) &&
        Boolean(params.nextSessionId) &&
        params.previousSessionId !== params.nextSessionId;
    const shouldRewriteSelection = typeof params.nextProvider === "string" ||
        typeof params.nextModel === "string" ||
        Object.hasOwn(params, "nextAuthProfileId") ||
        Object.hasOwn(params, "nextAuthProfileIdSource");
    if (!shouldRewriteSession && !shouldRewriteSelection) {
        return;
    }
    const rewriteRun = (run) => {
        if (!run) {
            return;
        }
        if (shouldRewriteSession && run.sessionId === params.previousSessionId) {
            run.sessionId = params.nextSessionId;
            const nextSessionFile = normalizeOptionalString(params.nextSessionFile);
            if (nextSessionFile) {
                run.sessionFile = nextSessionFile;
            }
        }
        if (shouldRewriteSelection) {
            if (typeof params.nextProvider === "string") {
                run.provider = params.nextProvider;
            }
            if (typeof params.nextModel === "string") {
                run.model = params.nextModel;
            }
            if (Object.hasOwn(params, "nextAuthProfileId")) {
                run.authProfileId = normalizeOptionalString(params.nextAuthProfileId);
            }
            if (Object.hasOwn(params, "nextAuthProfileIdSource")) {
                run.authProfileIdSource = run.authProfileId ? params.nextAuthProfileIdSource : undefined;
            }
        }
    };
    rewriteRun(queue.lastRun);
    for (const item of queue.items) {
        rewriteRun(item.run);
    }
}
