// Keeps the Discovery mirror converging on the Gateway's authority (OCF-313).
// Discovery is only a mirror, but a stale snapshot blocks kit enrollment (the
// new device signs at the mirror's seq + 1) and relay admission, so a failed
// publication must not wait for the next membership change. A publication is
// pending, durably in the claw record, from the moment a change asks for one
// until a publish succeeds with no newer request in between. Pending work runs
// now, again after transient failures with bounded exponential backoff, at
// startup and whenever the mailbox reconnects.
//
// Freshness (freshness/v1): clients treat a snapshot older than 3 h as no evidence,
// so a registered claw also re-signs and publishes at every start and again before
// SNAPSHOT_REPUBLISH_SECONDS pass after each successful publication, even when
// nothing changed.
import { SNAPSHOT_REPUBLISH_SECONDS } from "../../../packages/openclaw-id-protocol/src/index.js";
import type { StoredClaw } from "./claw-store.js";
import type { PublishOutcome } from "./publisher.js";

/** First retry delay after a transient failure. */
export const PUBLICATION_RETRY_INITIAL_MS = 2_000;
/** Longest delay between retries; retries continue at this pace until one succeeds. */
export const PUBLICATION_RETRY_MAX_MS = 5 * 60_000;
/**
 * Delay from a successful publication to the next re-sign: 55 minutes, jittered down by up
 * to 10%, so even with a few retries the published snapshot stays younger than an hour.
 */
export const PUBLICATION_REFRESH_MS = SNAPSHOT_REPUBLISH_SECONDS * 1000 - 5 * 60_000;

/**
 * True when Discovery may be behind the stored authority: a publication was
 * requested and not completed, or the recorded published seqs lag the record.
 * Before registration (no owner account) the Gateway can't publish without the
 * owner's one-time enrollment code, so nothing is pending.
 */
export function publicationPending(record: StoredClaw | undefined): boolean {
  if (!record?.authority || !record.discovery.owner_account_id) {
    return false;
  }
  return (
    record.discovery.publish_pending === true ||
    record.discovery.published_snapshot_seq < record.authority.seq ||
    record.discovery.published_binding_seq < (record.binding?.body.binding_seq ?? 0) ||
    (record.discovery.published_revocations ?? 0) < (record.revocations?.length ?? 0)
  );
}

// True when the claw is registered at Discovery, so the Gateway can publish on its own.
function registered(record: StoredClaw | undefined): boolean {
  return Boolean(record?.authority && record.discovery.owner_account_id);
}

type RetryLogger = { info: (message: string) => void; warn: (message: string) => void };

/** Dependencies of {@link createPublicationRetry}; delays and randomness are injectable for tests. */
export type PublicationRetryParams = {
  /** One publication attempt (descriptor and snapshot); undefined when not configured or linked. */
  publish: () => Promise<PublishOutcome | undefined>;
  /** The current claw record, read for {@link publicationPending}. */
  current: () => StoredClaw | undefined;
  /** Durably records whether a publication is pending. */
  setPending: (pending: boolean) => Promise<void>;
  log: RetryLogger;
  initialDelayMs?: number;
  maxDelayMs?: number;
  refreshMs?: number;
  /** Returns [0, 1); jitter spreads the retries of many Gateways after a Discovery outage. */
  random?: () => number;
};

/**
 * Creates the publication retrier. `request` asks for a publication after a
 * change; `resume` runs pending work now with the backoff reset (startup,
 * mailbox reconnect, a stale-seq refusal). Overlapping requests coalesce into
 * one follow-up attempt. `start` publishes once, and every success arms the next
 * re-sign. Retry and refresh timers run only between `start` and `stop`.
 */
export function createPublicationRetry(params: PublicationRetryParams) {
  const initialDelay = params.initialDelayMs ?? PUBLICATION_RETRY_INITIAL_MS;
  const maxDelay = params.maxDelayMs ?? PUBLICATION_RETRY_MAX_MS;
  const random = params.random ?? Math.random;
  const refreshMs = params.refreshMs ?? PUBLICATION_REFRESH_MS;
  let active = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshAt: number | undefined;
  let running = false;
  let rerun = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryAt: number | undefined;

  const cancelTimer = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = undefined;
    retryAt = undefined;
  };

  const cancelRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = undefined;
    refreshAt = undefined;
  };

  // Arms the next re-sign after a successful publication, replacing any earlier one.
  const armRefresh = () => {
    cancelRefresh();
    if (!active) {
      return;
    }
    const delay = Math.round(refreshMs * (0.9 + 0.1 * random()));
    refreshAt = Date.now() + delay;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refreshAt = undefined;
      void run();
    }, delay);
    refreshTimer.unref?.();
  };

  // Delay before retry number n (1-based): doubling from the initial delay,
  // capped, then jittered down by up to 20% so a retry never waits past the cap.
  const delayFor = (n: number) => {
    const base = Math.min(maxDelay, initialDelay * 2 ** (n - 1));
    return Math.round(base * (0.8 + 0.2 * random()));
  };

  const schedule = () => {
    if (!active || timer) {
      return;
    }
    attempt += 1;
    const delay = delayFor(attempt);
    retryAt = Date.now() + delay;
    params.log.info(
      `openclaw-id: Discovery publication pending; retry ${attempt} in ${Math.round(delay / 1000)}s`,
    );
    timer = setTimeout(() => {
      timer = undefined;
      retryAt = undefined;
      void run();
    }, delay);
    timer.unref?.();
  };

  // Every successful publication, direct or scheduled, replaces the refresh deadline here.
  const publishWithRefresh = async (
    publish: PublicationRetryParams["publish"],
  ): Promise<PublishOutcome | undefined> => {
    const outcome = await publish();
    if (outcome?.state === "published") {
      armRefresh();
    }
    return outcome;
  };

  // One attempt; reports whether a newer request arrived meanwhile and needs another.
  const attemptOnce = async (): Promise<"again" | "done"> => {
    rerun = false;
    const outcome = await publishWithRefresh(params.publish).catch(
      (error: unknown): PublishOutcome => ({
        state: "failed",
        code: "internal",
        message: String((error as Error)?.message ?? error),
        retryable: true,
      }),
    );
    if (outcome?.state === "published") {
      attempt = 0;
      if (rerun) {
        return "again";
      }
      await params.setPending(false);
      return "done";
    }
    if (outcome?.state === "failed" && outcome.retryable) {
      // The scheduled retry publishes the latest state, so newer requests are covered.
      rerun = false;
      schedule();
      return "done";
    }
    if (outcome?.state === "failed") {
      params.log.warn(
        `openclaw-id: Discovery publication refused (${outcome.code}); kept pending until the next start or change`,
      );
    }
    return "done";
  };

  // Runs attempts until one succeeds with no newer request, a failure is final
  // (not transient, or not publishable without the owner), or a retry is scheduled.
  const run = async (): Promise<void> => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      while ((await attemptOnce()) === "again") {
        // A request arrived during the attempt; publish the newer state.
      }
    } finally {
      running = false;
    }
  };

  return {
    /** Runs a caller's direct publication through the same refresh owner as scheduled attempts. */
    publishDirect: publishWithRefresh,

    /** Records a pending publication durably, then publishes (or joins the attempt in flight). */
    async request(): Promise<void> {
      await params.setPending(true);
      await run();
    },

    /**
     * Takes over after a publication the caller ran directly to report its outcome
     * (linking, owner-key regeneration): a failure stays pending durably, and a
     * transient one is retried with backoff.
     */
    async adopt(outcome: PublishOutcome | undefined): Promise<void> {
      if (outcome?.state !== "failed") {
        return;
      }
      await params.setPending(true);
      if (outcome.retryable && !running) {
        schedule();
      }
    },

    /** Publishes now, with the backoff reset, if a publication is pending. */
    async resume(): Promise<void> {
      // An attempt in flight publishes the same state; its outcome decides what follows.
      if (running || !publicationPending(params.current())) {
        return;
      }
      cancelTimer();
      attempt = 0;
      await run();
    },

    /**
     * Enables retry and refresh timers and publishes once (remote access started): pending
     * work, and a freshly signed snapshot even when Discovery is current.
     */
    async start(): Promise<void> {
      active = true;
      if (running || !registered(params.current())) {
        return;
      }
      cancelTimer();
      attempt = 0;
      await run();
    },

    /** Cancels any scheduled retry; the durable pending flag stays for the next start. */
    stop(): void {
      active = false;
      cancelTimer();
      cancelRefresh();
      attempt = 0;
    },

    /** When the next automatic retry runs (epoch ms), if one is scheduled. */
    nextRetryAt(): number | undefined {
      return retryAt;
    },

    /** When the next scheduled re-sign runs (epoch ms), if one is armed. */
    nextRefreshAt(): number | undefined {
      return refreshAt;
    },
  };
}

/** The retrier the OpenClaw ID service drives. */
export type PublicationRetry = ReturnType<typeof createPublicationRetry>;
