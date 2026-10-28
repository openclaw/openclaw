/** Public queue API for deferred auto-reply follow-up runs. */

export { scheduleFollowupDrain } from "./queue/drain.js";
export {
  claimNextQueuedFollowupRequestFrom,
  enqueueFollowupRun,
  getFollowupQueueDepth,
  reserveSteerCandidate,
} from "./queue/enqueue.js";
export { resolveQueueSettings } from "./queue/settings-runtime.js";
export { clearRemovedQueuedAuthProfiles, refreshQueuedFollowupSession } from "./queue/state.js";
export type { FollowupRun, QueueSettings } from "./queue/types.js";
export { resolveFollowupAbortSignal } from "./queue/types.js";
export { admitFollowupRunLifecycle, completeFollowupRunLifecycle } from "./queue/lifecycle.js";
