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
 * Creates the sender. `start` sends every unsettled pending unlink now and arms retries,
 * resolving when that run ends; `stop` cancels the retry timer and requests in flight. A start
 * during a run joins it with one follow-up pass; a start after a stop waits for the stopped run
 * to end, then runs anew.
 */
export function createPendingUnlinkSender(params: PendingUnlinkParams) {
  const initialDelay = params.initialDelayMs ?? PUBLICATION_RETRY_INITIAL_MS;
  const maxDelay = params.maxDelayMs ?? PUBLICATION_RETRY_MAX_MS;
  const random = params.random ?? Math.random;
  let active = false;
  let inflight: { done: Promise<void>; signal: AbortSignal } | undefined;
  let rerun = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lifetime = new AbortController();

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

  // Sends each unsettled pending unlink once; true when one must be sent again.
  const sendAll = async (signal: AbortSignal): Promise<boolean> => {
    let retry = false;
    for (const pending of params.current()?.pending_unlinks ?? []) {
      if (signal.aborted) {
        return false;
      }
      if (pending.refused) {
        continue;
      }
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
          retry = true;
          params.log.warn(`openclaw-id: unlink of ${label} not sent yet: ${String(error)}`);
          continue;
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
    }
    return retry;
  };

  // One run sends everything pending, again while more was requested meanwhile, then arms a
  // retry if a send failed. A stopped run ends without arming anything.
  const runOnce = async (signal: AbortSignal): Promise<void> => {
    let retry = false;
    for (;;) {
      rerun = false;
      try {
        retry = await sendAll(signal);
      } catch (error) {
        params.log.warn(`openclaw-id: pending unlink failed: ${String(error)}`);
        retry = true;
      }
      if (!rerun || signal.aborted) {
        break;
      }
    }
    if (!active || signal.aborted) {
      return;
    }
    if (retry) {
      schedule();
    } else {
      attempt = 0;
    }
  };

  const run = (): Promise<void> => {
    if (!active) {
      return Promise.resolve();
    }
    if (inflight) {
      if (inflight.signal.aborted) {
        return inflight.done.then(run);
      }
      rerun = true;
      return inflight.done;
    }
    cancelTimer();
    const signal = lifetime.signal;
    const done = runOnce(signal).finally(() => {
      inflight = undefined;
    });
    inflight = { done, signal };
    return done;
  };

  return {
    /** Sends every unsettled pending unlink now (backoff reset) and keeps retrying until stopped. */
    start(): Promise<void> {
      active = true;
      attempt = 0;
      return run();
    },
    stop(): void {
      active = false;
      rerun = false;
      cancelTimer();
      lifetime.abort();
      lifetime = new AbortController();
    },
  };
}
