import { formatDurationCompact } from "../../infra/format-time/format-duration.ts";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import type { ReplyPayload } from "../types.js";
import type { FollowupLifecycleRef } from "./queue.js";

type QueueLifecycleNoticeKind = "queued" | "delayed";

type QueueLifecycleEntry = {
  queueKey: string;
  enqueuedAt: number;
  queuedSent: boolean;
  delayedSent: boolean;
  queuedTimer?: ReturnType<typeof setTimeout>;
  delayedTimer?: ReturnType<typeof setTimeout>;
  sendNotice?: (payload: ReplyPayload) => Promise<void> | void;
};

const QUEUED_NOTICE_AFTER_MS = 2_000;
const DELAYED_NOTICE_AFTER_MS = 30_000;

const QUEUE_LIFECYCLE_STATE_KEY = Symbol.for("openclaw.followupQueueLifecycle");

function getLifecycleState() {
  return resolveGlobalMap<string, QueueLifecycleEntry>(QUEUE_LIFECYCLE_STATE_KEY);
}

function resolveLifecycleKey(params: { queueKey: string; run: FollowupLifecycleRef }): string {
  return JSON.stringify([
    params.queueKey,
    params.run.run.sessionId,
    params.run.messageId?.trim() ?? "",
    params.run.enqueuedAt,
  ]);
}

function clearLifecycleTimers(entry: QueueLifecycleEntry): void {
  if (entry.queuedTimer) {
    clearTimeout(entry.queuedTimer);
    entry.queuedTimer = undefined;
  }
  if (entry.delayedTimer) {
    clearTimeout(entry.delayedTimer);
    entry.delayedTimer = undefined;
  }
}

function buildQueueNotice(kind: QueueLifecycleNoticeKind): ReplyPayload {
  if (kind === "delayed") {
    return {
      text: "Still queued behind earlier work. I still have your message and will reply when the lane clears.",
    };
  }
  return {
    text: "Queued behind earlier work. I have your message and will reply when the lane clears.",
  };
}

function formatWaitDuration(waitedMs: number): string | undefined {
  return formatDurationCompact(waitedMs, { spaced: true }) ?? undefined;
}

async function emitLifecycleNotice(
  lifecycleKey: string,
  kind: QueueLifecycleNoticeKind,
): Promise<void> {
  const entry = getLifecycleState().get(lifecycleKey);
  if (!entry) {
    return;
  }
  if (kind === "queued") {
    if (entry.queuedSent) {
      return;
    }
    entry.queuedSent = true;
  } else {
    if (entry.delayedSent) {
      return;
    }
    entry.delayedSent = true;
  }
  await entry.sendNotice?.(buildQueueNotice(kind));
}

export function registerQueuedFollowupLifecycle(params: {
  queueKey: string;
  run: FollowupLifecycleRef;
  sendNotice?: (payload: ReplyPayload) => Promise<void> | void;
}): void {
  const lifecycleKey = resolveLifecycleKey(params);
  const lifecycleState = getLifecycleState();
  const existing = lifecycleState.get(lifecycleKey);
  if (existing) {
    clearLifecycleTimers(existing);
  }
  const entry: QueueLifecycleEntry = {
    queueKey: params.queueKey,
    enqueuedAt: params.run.enqueuedAt,
    queuedSent: false,
    delayedSent: false,
    sendNotice: params.sendNotice,
  };
  lifecycleState.set(lifecycleKey, entry);
  entry.queuedTimer = setTimeout(() => {
    void emitLifecycleNotice(lifecycleKey, "queued");
  }, QUEUED_NOTICE_AFTER_MS);
  entry.delayedTimer = setTimeout(() => {
    void emitLifecycleNotice(lifecycleKey, "delayed");
  }, DELAYED_NOTICE_AFTER_MS);
}

export function consumeQueuedFollowupStartNotice(params: {
  queueKey: string;
  run?: FollowupLifecycleRef;
  refs?: FollowupLifecycleRef[];
  remainingQueuedCount?: number;
}): ReplyPayload | undefined {
  const refs = params.refs?.length ? params.refs : params.run ? [params.run] : [];
  if (refs.length === 0) {
    return undefined;
  }
  const lifecycleState = getLifecycleState();
  const entries = refs
    .map((ref) => {
      const lifecycleKey = resolveLifecycleKey({
        queueKey: params.queueKey,
        run: ref,
      });
      const entry = lifecycleState.get(lifecycleKey);
      return entry ? { lifecycleKey, entry } : undefined;
    })
    .filter((entry): entry is { lifecycleKey: string; entry: QueueLifecycleEntry } =>
      Boolean(entry),
    );
  if (entries.length === 0) {
    return undefined;
  }
  for (const { lifecycleKey, entry } of entries) {
    clearLifecycleTimers(entry);
    lifecycleState.delete(lifecycleKey);
  }
  const oldestEnqueuedAt = Math.min(...entries.map(({ entry }) => entry.enqueuedAt));
  const waitedMs = Date.now() - oldestEnqueuedAt;
  const queuedSent = entries.some(({ entry }) => entry.queuedSent);
  const delayedSent = entries.some(({ entry }) => entry.delayedSent);
  const shouldExplain = queuedSent || delayedSent || waitedMs >= QUEUED_NOTICE_AFTER_MS;
  if (!shouldExplain) {
    return undefined;
  }
  const shouldCatchUp =
    delayedSent || (params.remainingQueuedCount ?? 0) > 0 || waitedMs >= DELAYED_NOTICE_AFTER_MS;
  const waitDuration = formatWaitDuration(waitedMs);
  return {
    text: shouldCatchUp
      ? `Catching up after backlog cleared${waitDuration ? ` after ${waitDuration}` : ""}. Thanks for waiting.`
      : `Resumed after backlog cleared${waitDuration ? ` after ${waitDuration}` : ""}. Thanks for waiting.`,
  };
}

export function clearQueuedFollowupLifecycleForQueue(queueKey: string): void {
  const cleaned = queueKey.trim();
  if (!cleaned) {
    return;
  }
  const lifecycleState = getLifecycleState();
  for (const [key, entry] of lifecycleState.entries()) {
    if (entry.queueKey !== cleaned) {
      continue;
    }
    clearLifecycleTimers(entry);
    lifecycleState.delete(key);
  }
}

export function resetQueuedFollowupLifecycleForTests(): void {
  const lifecycleState = getLifecycleState();
  for (const entry of lifecycleState.values()) {
    clearLifecycleTimers(entry);
  }
  lifecycleState.clear();
}
