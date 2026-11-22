// Sends unlinks this computer committed that Discovery has not confirmed (OCF-281). The claw is
// already unlinked here; Discovery still lists it, admits its keys at the relay and keeps its name
// live until it takes the ClawUnlink. Pending unlinks are sent at once, again after transient
// failures with bounded exponential backoff, and at every start, until Discovery confirms each
// one. This is the unlink's only retry.
//
// Only a success or Discovery's `unlinked` answer confirms an unlink; confirmed entries are
// dropped. A refusal no resend can change (another 4xx) stays stored as refused, with its code,
// so status keeps showing that the address was not retired; it is not sent again.
import type {
  SignedStatement,
  StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { StoredClaw } from "./claw-store.js";
import { createDiscoveryClient, DiscoveryRequestError } from "./discovery-client.js";
import { PUBLICATION_RETRY_INITIAL_MS, PUBLICATION_RETRY_MAX_MS } from "./publication-retry.js";

type Logger = { info: (message: string) => void; warn: (message: string) => void };

/** How one send ended. */
export type UnlinkSendOutcome =
  | { kind: "confirmed" }
  | { kind: "refused"; code: string }
  | { kind: "retry" };

/** Dependencies of {@link createPendingUnlinkSender}; delays and fetch are injectable for tests. */
export type PendingUnlinkParams = {
  /** The current claw record, holding `pending_unlinks`. */
  current: () => StoredClaw | undefined;
  /** Durably records a confirmed (dropped) or refused (kept, not resent) pending unlink. */
  settle: (
    statement: SignedStatement<"ClawUnlink">,
    outcome: Exclude<UnlinkSendOutcome, { kind: "retry" }>,
  ) => Promise<void>;
  /** Signs the requests (Discovery takes the statement as the credential). */
  signer: () => Promise<StatementSigner>;
  log: Logger;
  fetchImpl?: typeof fetch;
  initialDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
};

// What Discovery's answer means for this statement.
function outcomeOf(error: unknown): UnlinkSendOutcome {
  if (!(error instanceof DiscoveryRequestError)) {
    return { kind: "retry" };
  }
  if (error.code === "unlinked") {
    return { kind: "confirmed" };
  }
  return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
    ? { kind: "refused", code: error.code }
    : { kind: "retry" };
}

/**
 * Creates the sender. `start` resumes delivery once per lifetime, joining an active run without
 * extending it. `flush` sends one newly committed unlink on its own request and resolves when that
 * attempt ends, so older pending unlinks never delay it; if it must be sent again the sender's
 * backoff takes it over. `stop` cancels retries and requests; a start after a stop waits for the
 * stopped run to end, then runs anew.
 */
export function createPendingUnlinkSender(params: PendingUnlinkParams) {
  const initialDelay = params.initialDelayMs ?? PUBLICATION_RETRY_INITIAL_MS;
  const maxDelay = params.maxDelayMs ?? PUBLICATION_RETRY_MAX_MS;
  const random = params.random ?? Math.random;
  let active = false;
  let inflight: { done: Promise<void>; signal: AbortSignal } | undefined;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lifetime = new AbortController();
  // Statements a flush is sending right now; runs skip them so one statement has one request.
  const flushing = new Set<string>();
  // A flush left work to retry while a run was in flight; that run arms the retry as it ends.
  let retryAfterRun = false;

  const cancelTimer = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = undefined;
  };

  const schedule = () => {
    cancelTimer();
    attempt += 1;
    const base = Math.min(maxDelay, initialDelay * 2 ** (attempt - 1));
    const delay = Math.round(base * (0.8 + 0.2 * random()));
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delay);
    timer.unref?.();
  };

  // Arms a retry for work a flush could not deliver, unless one is already coming.
  const retryLater = () => {
    if (!active) {
      return;
    }
    if (inflight) {
      retryAfterRun = true;
    } else if (!timer) {
      schedule();
    }
  };

  type Pending = NonNullable<StoredClaw["pending_unlinks"]>[number];

  // Sends one pending unlink and records a final answer; true when it must be sent again.
  const sendOne = async (pending: Pending, signal: AbortSignal): Promise<boolean> => {
    const label = `${pending.hostname} (claw ${pending.statement.body.claw_id})`;
    let outcome: UnlinkSendOutcome;
    try {
      await createDiscoveryClient({
        baseUrl: pending.discovery_url,
        signer: await params.signer(),
        signal,
        ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
      }).unlinkClaw(pending.statement);
      outcome = { kind: "confirmed" };
    } catch (error) {
      if (signal.aborted) {
        return false;
      }
      outcome = outcomeOf(error);
      if (outcome.kind === "retry") {
        params.log.warn(`openclaw-id: unlink of ${label} not sent yet: ${String(error)}`);
        return true;
      }
    }
    if (outcome.kind === "confirmed") {
      params.log.info(`openclaw-id: Discovery unlinked ${label}`);
    } else {
      params.log.warn(
        `openclaw-id: Discovery refused the unlink of ${label} (${outcome.code}); it is not sent again`,
      );
    }
    await params.settle(pending.statement, outcome);
    return false;
  };

  // Sends each unsettled pending unlink once; true when one must be sent again.
  const sendAll = async (signal: AbortSignal): Promise<boolean> => {
    let retry = false;
    for (const pending of params.current()?.pending_unlinks ?? []) {
      if (signal.aborted) {
        return false;
      }
      if (pending.refused || flushing.has(pending.statement.sig)) {
        continue;
      }
      retry = (await sendOne(pending, signal)) || retry;
    }
    return retry;
  };

  const sendAllSafely = async (signal: AbortSignal): Promise<boolean> => {
    try {
      return await sendAll(signal);
    } catch (error) {
      params.log.warn(`openclaw-id: pending unlink failed: ${String(error)}`);
      return true;
    }
  };

  // One run sends everything pending. It decides on a retry in the same step that clears
  // `inflight`, so a flush either sees the run and leaves the retry to it, or arms its own.
  // A stopped run ends without arming anything.
  const run = (): Promise<void> => {
    if (!active) {
      return Promise.resolve();
    }
    if (inflight) {
      return inflight.signal.aborted ? inflight.done.then(run) : inflight.done;
    }
    cancelTimer();
    const signal = lifetime.signal;
    const done = sendAllSafely(signal).then((retry) => {
      inflight = undefined;
      const again = retry || retryAfterRun;
      retryAfterRun = false;
      if (!active || signal.aborted) {
        return;
      }
      if (again) {
        schedule();
      } else {
        attempt = 0;
      }
    });
    inflight = { done, signal };
    return done;
  };

  const resume = (): Promise<void> => {
    if (active) {
      return inflight?.done ?? Promise.resolve();
    }
    active = true;
    attempt = 0;
    return run();
  };

  return {
    /** Resumes delivery once per lifetime, joining active work or preserving its backoff. */
    start: resume,
    /**
     * Sends the newly committed `statement` now, on its own request, and resolves when that
     * attempt ends. Other pending unlinks keep their own run and backoff.
     */
    async flush(statement: SignedStatement<"ClawUnlink">): Promise<void> {
      const pending = params
        .current()
        ?.pending_unlinks?.find((entry) => entry.statement.sig === statement.sig);
      if (!pending || pending.refused || flushing.has(statement.sig)) {
        void resume();
        return;
      }
      flushing.add(statement.sig);
      void resume();
      const signal = lifetime.signal;
      let again = true;
      try {
        again = (await sendOne(pending, signal)) || signal.aborted;
      } catch (error) {
        params.log.warn(`openclaw-id: pending unlink failed: ${String(error)}`);
      } finally {
        flushing.delete(statement.sig);
      }
      if (again) {
        retryLater();
      }
    },
    stop(): void {
      active = false;
      retryAfterRun = false;
      cancelTimer();
      lifetime.abort();
      lifetime = new AbortController();
    },
  };
}
