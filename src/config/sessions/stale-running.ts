import fs from "node:fs";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "./paths.js";
import { resolveSessionStoreEntry } from "./store-entry.js";
import { updateSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

type ActiveTaskLike = {
  status?: string;
  ownerKey?: string;
  requesterSessionKey?: string;
  childSessionKey?: string;
  runId?: string;
};

export type StaleRunningSessionRepair = {
  key: string;
  previousStatus: "running";
  nextStatus: NonNullable<SessionEntry["status"]>;
  reason: "no-active-run";
  endedAt: number;
};

export type StaleRunningSessionReconcileResult = {
  repaired: StaleRunningSessionRepair[];
  skippedActive: string[];
};

const DEFAULT_STALE_RUNNING_MIN_AGE_MS = 2 * 60_000;

function isActiveTaskStatus(status: string | undefined): boolean {
  return status === "queued" || status === "running";
}

function normalizeKeySet(keys?: Iterable<string | undefined>): Set<string> {
  const normalized = new Set<string>();
  for (const key of keys ?? []) {
    const trimmed = normalizeOptionalString(key);
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return normalized;
}

function taskMatchesSession(params: {
  task: ActiveTaskLike;
  sessionKeys: ReadonlySet<string>;
  runId?: string | null;
}): boolean {
  const taskRunId = normalizeOptionalString(params.task.runId);
  const runId = normalizeOptionalString(params.runId);
  if (runId && taskRunId === runId) {
    return true;
  }
  for (const candidate of [
    params.task.ownerKey,
    params.task.requesterSessionKey,
    params.task.childSessionKey,
  ]) {
    const key = normalizeOptionalString(candidate);
    if (key && params.sessionKeys.has(key)) {
      return true;
    }
  }
  return false;
}

function hasActiveTaskForSession(params: {
  tasks?: ActiveTaskLike[];
  sessionKeys: ReadonlySet<string>;
  runId?: string | null;
}): boolean {
  return (params.tasks ?? []).some(
    (task) =>
      isActiveTaskStatus(task.status) &&
      taskMatchesSession({
        task,
        sessionKeys: params.sessionKeys,
        runId: params.runId,
      }),
  );
}

function readRecentTranscriptTail(params: { storePath: string; entry: SessionEntry }): unknown[] {
  if (!params.entry.sessionId) {
    return [];
  }
  try {
    const transcriptPath = resolveSessionFilePath(
      params.entry.sessionId,
      params.entry,
      resolveSessionFilePathOptions({ storePath: params.storePath }),
    );
    const raw = fs.readFileSync(transcriptPath, "utf-8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-20);
    const tail: unknown[] = [];
    for (const line of lines) {
      try {
        tail.push(JSON.parse(line));
      } catch {
        // Ignore malformed tail lines; reconciliation remains conservative.
      }
    }
    return tail;
  } catch {
    return [];
  }
}

function readLineMessage(line: unknown): unknown {
  if (!line || typeof line !== "object") {
    return undefined;
  }
  return (line as { message?: unknown }).message ?? line;
}

function readMessageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function hasEndedTranscriptTrace(params: { storePath: string; entry: SessionEntry }): boolean {
  const tail = readRecentTranscriptTail(params);
  const lastMessage = tail.map(readLineMessage).toReversed().find((message) => {
    const role = readMessageRole(message);
    return Boolean(role && role !== "system");
  });
  const role = readMessageRole(lastMessage);
  if (role === "assistant") {
    return true;
  }
  if (lastMessage && typeof lastMessage === "object") {
    const openclawAbort = (lastMessage as { openclawAbort?: unknown }).openclawAbort;
    if (openclawAbort && typeof openclawAbort === "object") {
      return true;
    }
  }
  return false;
}

function resolveStaleRunningStatus(params: {
  entry: SessionEntry;
  storePath: string;
}): NonNullable<SessionEntry["status"]> {
  if (params.entry.replyTurnState === "failed") {
    return "failed";
  }
  if (params.entry.replyTurnState === "aborted" || params.entry.abortedLastRun === true) {
    return "aborted";
  }
  if (hasEndedTranscriptTrace(params)) {
    return "done";
  }
  return "lost";
}

function sessionIsOldEnough(entry: SessionEntry, now: number, minAgeMs: number): boolean {
  if (minAgeMs <= 0) {
    return true;
  }
  const lastProgressAt =
    typeof entry.replyTurnUpdatedAt === "number"
      ? entry.replyTurnUpdatedAt
      : typeof entry.updatedAt === "number"
        ? entry.updatedAt
        : typeof entry.startedAt === "number"
          ? entry.startedAt
          : undefined;
  return typeof lastProgressAt !== "number" || now - lastProgressAt >= minAgeMs;
}

export async function reconcileStaleRunningSessions(params: {
  storePath: string;
  sessionKeys?: string[];
  activeRunSessionKeys?: Iterable<string | undefined>;
  activeTasks?: ActiveTaskLike[];
  now?: number;
  minAgeMs?: number;
}): Promise<StaleRunningSessionReconcileResult> {
  const repaired: StaleRunningSessionRepair[] = [];
  const skippedActive: string[] = [];
  const activeRunSessionKeys = normalizeKeySet(params.activeRunSessionKeys);
  const requestedSessionKeys = normalizeKeySet(params.sessionKeys);
  const now = params.now ?? Date.now();
  const minAgeMs = params.minAgeMs ?? DEFAULT_STALE_RUNNING_MIN_AGE_MS;

  await updateSessionStore(
    params.storePath,
    (store) => {
      const entries =
        requestedSessionKeys.size > 0
          ? [...requestedSessionKeys]
              .map((sessionKey) => {
                const resolved = resolveSessionStoreEntry({ store, sessionKey });
                const primaryKey = [resolved.normalizedKey, ...resolved.legacyKeys].find(
                  (candidate) => store[candidate] === resolved.existing,
                );
                return primaryKey ? ([primaryKey, resolved.existing] as const) : undefined;
              })
              .filter(
                (entry): entry is readonly [string, SessionEntry | undefined] =>
                  entry !== undefined,
              )
          : Object.entries(store);

      for (const [key, entry] of entries) {
        if (!entry || entry.status !== "running") {
          continue;
        }
        const sessionKeys = new Set([key, ...requestedSessionKeys]);
        const runId = normalizeOptionalString(entry.replyTurnRunId);
        if (
          activeRunSessionKeys.has(key) ||
          hasActiveTaskForSession({
            tasks: params.activeTasks,
            sessionKeys,
            runId,
          })
        ) {
          skippedActive.push(key);
          continue;
        }
        if (!sessionIsOldEnough(entry, now, minAgeMs)) {
          skippedActive.push(key);
          continue;
        }
        const endedAt = now;
        const nextStatus = resolveStaleRunningStatus({
          entry,
          storePath: params.storePath,
        });
        const startedAt =
          typeof entry.startedAt === "number"
            ? entry.startedAt
            : typeof entry.replyTurnStartedAt === "number"
              ? entry.replyTurnStartedAt
              : undefined;
        entry.status = nextStatus;
        entry.endedAt = endedAt;
        entry.updatedAt = endedAt;
        entry.replyTurnState =
          nextStatus === "done"
            ? "completed"
            : nextStatus === "aborted"
              ? "aborted"
              : "failed";
        entry.replyTurnUpdatedAt = endedAt;
        entry.abortedLastRun = nextStatus === "aborted" || nextStatus === "lost" ? true : false;
        if (typeof startedAt === "number" && endedAt >= startedAt) {
          entry.startedAt = startedAt;
          entry.runtimeMs = (entry.runtimeMs ?? 0) + (endedAt - startedAt);
        }
        repaired.push({
          key,
          previousStatus: "running",
          nextStatus,
          reason: "no-active-run",
          endedAt,
        });
      }
    },
    { skipMaintenance: true },
  );

  return { repaired, skippedActive };
}
