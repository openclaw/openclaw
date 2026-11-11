import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { racePromiseWithAbortSignal, raceWithTimeout } from "../../packages/retry/src/index.js";
import type {
  ReplyRunAdmissionSource,
  ReplyRunWaiter,
  SessionControllerEntry,
} from "./session-controller.contracts.js";
import {
  findSessionControllerEntries,
  getSessionControllerEntry,
  mergeReplyRunAdmissionSource,
  pruneSessionControllerEntry,
} from "./session-controller.state.js";
import type { SessionTarget } from "./session-controller.target.js";

function waitForSessionControllerEntryIdle(
  owner: SessionControllerEntry,
  timeoutMs?: number | null,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!owner.active) {
    return Promise.resolve(true);
  }
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const waiters = owner.waiters;
    let abortHandler: (() => void) | undefined;
    let settled = false;
    const waiter: ReplyRunWaiter = {
      finish: (ended) => {
        if (settled) {
          return;
        }
        settled = true;
        waiters.delete(waiter);
        pruneSessionControllerEntry(owner);
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        if (abortHandler) {
          signal?.removeEventListener("abort", abortHandler);
        }
        resolve(ended);
      },
    };
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
      waiter.timer = setTimeout(
        () => waiter.finish(false),
        resolveTimerTimeoutMs(timeoutMs, 100, 100),
      );
    }
    if (signal) {
      abortHandler = () => waiter.finish(false);
      signal.addEventListener("abort", abortHandler, { once: true });
    }
    waiters.add(waiter);
  });
}

/** Waits for every active physical owner selected by a logical key to release its slot. */
export function waitForSessionRunIdle(
  sessionKey: string,
  timeoutMs?: number | null,
  opts?: { signal?: AbortSignal },
): Promise<boolean> {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey) {
    return Promise.resolve(true);
  }
  const owners = findSessionControllerEntries(normalizedSessionKey).filter((entry) => entry.active);
  return Promise.all(
    owners.map((owner) => waitForSessionControllerEntryIdle(owner, timeoutMs, opts?.signal)),
  ).then((outcomes) => outcomes.every(Boolean));
}

type ReplyRunAdmissionSettlement = { settled: boolean; sources?: ReplyRunAdmissionSource[] };

type ReplyRunAdmissionWaitOptions = { signal?: AbortSignal; target?: SessionTarget };

async function waitForReplyRunAdmissionBarrier(
  barrierKind: "followupBarrier" | "successorBarrier",
  minimumTimeoutMs: number,
  sessionKey: string,
  timeoutMs: number | null | undefined,
  opts: ReplyRunAdmissionWaitOptions | undefined,
): Promise<ReplyRunAdmissionSettlement> {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey) {
    return { settled: true };
  }
  const signal = opts?.signal;
  const deadline =
    typeof timeoutMs === "number"
      ? Date.now() + resolveTimerTimeoutMs(timeoutMs, minimumTimeoutMs, minimumTimeoutMs)
      : undefined;
  const sources = new Map<ReplyRunAdmissionSource["databaseIdentity"], ReplyRunAdmissionSource>();
  while (true) {
    if (signal?.aborted) {
      return { settled: false };
    }
    const barrier = getSessionControllerEntry(normalizedSessionKey, opts?.target)[barrierKind];
    if (!barrier) {
      return { settled: true, ...(sources.size ? { sources: [...sources.values()] } : {}) };
    }
    const remainingMs = deadline === undefined ? undefined : deadline - Date.now();
    if (remainingMs !== undefined && remainingMs <= 0) {
      return { settled: false };
    }
    const settled = barrier.settled.then(() => true);
    const aborted = new Error("Admission wait aborted");
    const outcome = await (remainingMs === undefined
      ? racePromiseWithAbortSignal(settled, signal, () => aborted).catch((error: unknown) => {
          if (error === aborted) {
            return false;
          }
          throw error;
        })
      : raceWithTimeout(settled, Math.max(1, remainingMs), () => false, {
          ref: false,
          signal,
          onAbort: () => false,
        }));
    if (!outcome) {
      return { settled: false };
    }
    for (const [identity, source] of barrier.sources) {
      sources.set(
        identity,
        mergeReplyRunAdmissionSource(
          { ...source, sessionIds: new Set(source.sessionIds) },
          sources.get(identity),
        ),
      );
    }
  }
}

export function waitForReplyRunFollowupAdmission(
  sessionKey: string,
  timeoutMs: number,
  opts?: ReplyRunAdmissionWaitOptions,
): Promise<ReplyRunAdmissionSettlement> {
  return waitForReplyRunAdmissionBarrier("followupBarrier", 100, sessionKey, timeoutMs, opts);
}

export function waitForReplyRunSuccessorAdmission(
  sessionKey: string,
  timeoutMs?: number | null,
  opts?: ReplyRunAdmissionWaitOptions,
): Promise<ReplyRunAdmissionSettlement> {
  return waitForReplyRunAdmissionBarrier("successorBarrier", 0, sessionKey, timeoutMs, opts);
}
