// Cleans stale queue state and recent dedupe entries.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveEmbeddedSessionLane } from "../../../agents/embedded-agent-runner/lanes.js";
import {
  clearCommandLane,
  clearCommandLaneByAuthorizationAffinity,
} from "../../../process/command-queue.js";
import { clearFollowupDrainCallback } from "./drain.js";
import {
  clearFollowupQueue,
  clearFollowupQueueByAuthorizationAffinity,
  getExistingFollowupQueue,
} from "./state.js";

export type ClearSessionQueueResult = {
  followupCleared: number;
  laneCleared: number;
  keys: string[];
};

const defaultQueueCleanupDeps = {
  resolveEmbeddedSessionLane,
  clearCommandLane,
  clearCommandLaneByAuthorizationAffinity,
};

const queueCleanupDeps = {
  ...defaultQueueCleanupDeps,
};

function resolveQueueCleanupLaneResolver() {
  return typeof queueCleanupDeps.resolveEmbeddedSessionLane === "function"
    ? queueCleanupDeps.resolveEmbeddedSessionLane
    : defaultQueueCleanupDeps.resolveEmbeddedSessionLane;
}

function resolveQueueCleanupLaneClearer() {
  return typeof queueCleanupDeps.clearCommandLane === "function"
    ? queueCleanupDeps.clearCommandLane
    : defaultQueueCleanupDeps.clearCommandLane;
}

function resolveQueueCleanupSelectiveLaneClearer() {
  return typeof queueCleanupDeps.clearCommandLaneByAuthorizationAffinity === "function"
    ? queueCleanupDeps.clearCommandLaneByAuthorizationAffinity
    : defaultQueueCleanupDeps.clearCommandLaneByAuthorizationAffinity;
}

const queueCleanupTestApi = {
  setDepsForTests(deps: Partial<typeof defaultQueueCleanupDeps> | undefined): void {
    queueCleanupDeps.resolveEmbeddedSessionLane =
      typeof deps?.resolveEmbeddedSessionLane === "function"
        ? deps.resolveEmbeddedSessionLane
        : defaultQueueCleanupDeps.resolveEmbeddedSessionLane;
    queueCleanupDeps.clearCommandLane =
      typeof deps?.clearCommandLane === "function"
        ? deps.clearCommandLane
        : defaultQueueCleanupDeps.clearCommandLane;
    queueCleanupDeps.clearCommandLaneByAuthorizationAffinity =
      typeof deps?.clearCommandLaneByAuthorizationAffinity === "function"
        ? deps.clearCommandLaneByAuthorizationAffinity
        : defaultQueueCleanupDeps.clearCommandLaneByAuthorizationAffinity;
  },
  resetDepsForTests(): void {
    queueCleanupDeps.resolveEmbeddedSessionLane =
      defaultQueueCleanupDeps.resolveEmbeddedSessionLane;
    queueCleanupDeps.clearCommandLane = defaultQueueCleanupDeps.clearCommandLane;
    queueCleanupDeps.clearCommandLaneByAuthorizationAffinity =
      defaultQueueCleanupDeps.clearCommandLaneByAuthorizationAffinity;
  },
};

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.queueCleanupTestApi")] =
    queueCleanupTestApi;
}

export function clearSessionQueues(keys: Array<string | undefined>): ClearSessionQueueResult {
  const seen = new Set<string>();
  let followupCleared = 0;
  let laneCleared = 0;
  const clearedKeys: string[] = [];
  const resolveLane = resolveQueueCleanupLaneResolver();
  const clearLane = resolveQueueCleanupLaneClearer();

  for (const key of keys) {
    const cleaned = normalizeOptionalString(key);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    clearedKeys.push(cleaned);
    followupCleared += clearFollowupQueue(cleaned);
    clearFollowupDrainCallback(cleaned);
    laneCleared += clearLane(resolveLane(cleaned));
  }

  return { followupCleared, laneCleared, keys: clearedKeys };
}

/** Preserve work from other or unattributed controllers while interrupting one authority. */
export function clearSessionQueuesByAuthorizationAffinity(
  keys: Array<string | undefined>,
  authorizationAffinityKey: string | undefined,
): ClearSessionQueueResult {
  const seen = new Set<string>();
  let followupCleared = 0;
  let laneCleared = 0;
  const clearedKeys: string[] = [];
  const resolveLane = resolveQueueCleanupLaneResolver();
  const clearLane = resolveQueueCleanupSelectiveLaneClearer();

  for (const key of keys) {
    const cleaned = normalizeOptionalString(key);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    clearedKeys.push(cleaned);
    followupCleared += clearFollowupQueueByAuthorizationAffinity(cleaned, authorizationAffinityKey);
    if (!getExistingFollowupQueue(cleaned)) {
      clearFollowupDrainCallback(cleaned);
    }
    laneCleared += clearLane(resolveLane(cleaned), authorizationAffinityKey);
  }

  return { followupCleared, laneCleared, keys: clearedKeys };
}
