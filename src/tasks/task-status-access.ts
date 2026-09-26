import { parseCronRunScopeSuffix } from "../sessions/session-key-utils.js";
import {
  getAllActiveGeneratedMediaSessionKeys,
  getLatestGeneratedMediaTaskAdmissionIdForSessionKey,
  listActiveGeneratedMediaTaskIdsForSessionKey,
} from "./generated-media-task-activity.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
// Filters task status visibility by requester, owner, and flow scope.
import {
  findTaskByRunId,
  listTaskRecords,
  listTaskSessionActivity,
  listTasksByRunId,
  listTasksForRelatedSessionKey,
} from "./task-registry.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";
import { buildTaskStatusSnapshot } from "./task-status.js";

const GENERATED_MEDIA_TASK_KINDS = new Set([
  "image_generation",
  "music_generation",
  "video_generation",
]);

export function listTasksForSessionKeyForStatus(
  sessionKey: string,
  sessionAgentId?: string,
): TaskRecord[] {
  return listTasksForRelatedSessionKey(sessionKey, sessionAgentId);
}

function listTasksForOwnerOrRequesterSessionKeyForStatus(sessionKey: string): TaskRecord[] {
  return listTaskRecords(
    (task) => task.requesterSessionKey === sessionKey || task.ownerKey === sessionKey,
  );
}

/** Session details and agent fallback counts share one accepted-write read. */
export async function readTaskStatusSnapshots(params: { sessionKey?: string; agentId: string }) {
  const read = await prepareTaskRegistryRead();
  if (!read) {
    throw new Error("Task activity did not stabilize. Retry the status lookup.");
  }
  const session = buildTaskStatusSnapshot(
    params.sessionKey === undefined
      ? []
      : read.listTasksForRelatedSessionKey(params.sessionKey, params.agentId),
  );
  return {
    session,
    agent:
      session.totalCount === 0
        ? buildTaskStatusSnapshot(read.listTasksForAgentId(params.agentId))
        : undefined,
    assertCurrent: read.assertCurrent,
  };
}

export function findTaskByRunIdForStatus(runId: string): TaskRecord | undefined {
  return findTaskByRunId(runId);
}

/**
 * Run ids are not unique across runtimes, and the preferred-row lookup deprioritizes
 * only `cli`, so an older `cron` or `acp` row can be selected ahead of the row a
 * runtime-scoped caller asked for. Listing the run id lets that caller match on its
 * own runtime instead of rejecting whichever row the shared preference happened to
 * pick. `findTaskByRunIdForStatus` is this list's first entry, so both apply the same
 * superseded-backing filter; a raw state read would surface rows the single lookup
 * deliberately hides.
 */
export function listTasksByRunIdForStatus(runId: string): TaskRecord[] {
  return listTasksByRunId(runId);
}

/** Snapshots generated-media task ids so replay guards stay attempt-local. */
export function getGeneratedMediaTaskIdsForSessionKey(
  sessionKey: string | undefined,
): ReadonlySet<string> {
  if (!sessionKey || !parseCronRunScopeSuffix(sessionKey).runId) {
    return new Set();
  }
  const taskIds = listTasksForOwnerOrRequesterSessionKeyForStatus(sessionKey)
    .filter((task) => GENERATED_MEDIA_TASK_KINDS.has(task.taskKind ?? ""))
    .map((task) => task.taskId);
  const latestAdmission = getLatestGeneratedMediaTaskAdmissionIdForSessionKey(sessionKey);
  return new Set([...taskIds, ...(latestAdmission ? [`run:${latestAdmission}`] : [])]);
}

/** Returns whether one attempt admitted generated-media work after its snapshot. */
export function hasNewGeneratedMediaTaskForSessionKey(
  sessionKey: string | undefined,
  before: ReadonlySet<string>,
): boolean {
  for (const taskId of getGeneratedMediaTaskIdsForSessionKey(sessionKey)) {
    if (!before.has(taskId)) {
      return true;
    }
  }
  return false;
}

/** Returns whether generated-media work still needs this run's continuation row. */
export function hasPendingGeneratedMediaTaskForSessionKey(sessionKey: string): boolean {
  if (!parseCronRunScopeSuffix(sessionKey).runId) {
    return false;
  }
  if (listActiveGeneratedMediaTaskIdsForSessionKey(sessionKey).length > 0) {
    return true;
  }
  return listTasksForOwnerOrRequesterSessionKeyForStatus(sessionKey).some(
    (task) =>
      GENERATED_MEDIA_TASK_KINDS.has(task.taskKind ?? "") && !isTerminalTaskStatus(task.status),
  );
}

/**
 * Builds a one-shot snapshot of all session keys with pending generated-media
 * work. Consume this once per reaper sweep for O(1) per-row lookups instead of
 * repeating global task and activity scans for every cron continuation row.
 */
export function buildPendingGeneratedMediaSessionKeySet(): Set<string> {
  const keys = getAllActiveGeneratedMediaSessionKeys();
  for (const task of listTaskSessionActivity()) {
    if (GENERATED_MEDIA_TASK_KINDS.has(task.taskKind ?? "") && !isTerminalTaskStatus(task.status)) {
      if (task.requesterSessionKey) {
        keys.add(task.requesterSessionKey);
      }
      if (task.ownerKey) {
        keys.add(task.ownerKey);
      }
    }
  }
  return keys;
}
