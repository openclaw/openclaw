import { clearSessionStoreCaches } from "./store-cache.js";
export const LOCK_QUEUES = new Map();
export function clearSessionStoreCacheForTest() {
    clearSessionStoreCaches();
    for (const queue of LOCK_QUEUES.values()) {
        for (const task of queue.pending) {
            task.reject(new Error("session store queue cleared for test"));
        }
    }
    LOCK_QUEUES.clear();
}
export async function drainSessionStoreLockQueuesForTest() {
    while (LOCK_QUEUES.size > 0) {
        const queues = [...LOCK_QUEUES.values()];
        for (const queue of queues) {
            for (const task of queue.pending) {
                task.reject(new Error("session store queue cleared for test"));
            }
            queue.pending.length = 0;
        }
        const activeDrains = queues.flatMap((queue) => queue.drainPromise ? [queue.drainPromise] : []);
        if (activeDrains.length === 0) {
            LOCK_QUEUES.clear();
            return;
        }
        await Promise.allSettled(activeDrains);
    }
}
export function getSessionStoreLockQueueSizeForTest() {
    return LOCK_QUEUES.size;
}
