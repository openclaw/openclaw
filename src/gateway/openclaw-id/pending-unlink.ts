// Sends unlinks this computer committed while Discovery could not be reached (OCF-281). The
// claw is already unlinked here; Discovery still lists it, admits its keys at the relay and keeps
// its name live until it gets the ClawUnlink. Pending unlinks are sent at once, again after
// transient failures with bounded exponential backoff, and at every start, until Discovery
// confirms each one. This is the unlink's only retry.
import type {
  SignedStatement,
  StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { StoredClaw } from "./claw-store.js";
import { createDiscoveryClient, DiscoveryRequestError } from "./discovery-client.js";
import { PUBLICATION_RETRY_INITIAL_MS, PUBLICATION_RETRY_MAX_MS } from "./publication-retry.js";

type Logger = { info: (message: string) => void; warn: (message: string) => void };

/** Dependencies of {@link createPendingUnlinkSender}; delays and fetch are injectable for tests. */
export type PendingUnlinkParams = {
  /** The current claw record, holding `pending_unlinks`. */
  current: () => StoredClaw | undefined;
  /** Durably drops one pending unlink. */
  clear: (statement: SignedStatement<"ClawUnlink">) => Promise<void>;
  /** Signs the requests (Discovery takes the statement as the credential). */
  signer: () => Promise<StatementSigner>;
  log: Logger;
  fetchImpl?: typeof fetch;
  initialDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
};

// Whether Discovery's answer is final for this statement: confirmed (or unlinked before), an
// unknown claw, or a refusal a resend cannot change.
function settles(error: unknown): boolean {
  if (!(error instanceof DiscoveryRequestError)) {
    return false;
  }
  return (
    error.code === "unlinked" ||
    (error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429)
  );
}

/**
 * Creates the sender. `start` sends every pending unlink now and arms retries, resolving when
 * that run ends; `stop` cancels the retry timer and requests in flight. A start during a run
 * joins it and adds one follow-up pass.
 */
export function createPendingUnlinkSender(params: PendingUnlinkParams) {
  const initialDelay = params.initialDelayMs ?? PUBLICATION_RETRY_INITIAL_MS;
  const maxDelay = params.maxDelayMs ?? PUBLICATION_RETRY_MAX_MS;
  const random = params.random ?? Math.random;
  let active = false;
  let inflight: Promise<void> | undefined;
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

  // Sends each pending unlink once; true when one must be sent again.
  const sendAll = async (signal: AbortSignal): Promise<boolean> => {
    let retry = false;
    for (const pending of params.current()?.pending_unlinks ?? []) {
      if (signal.aborted) {
        return false;
      }
      const label = `${pending.hostname} (claw ${pending.statement.body.claw_id})`;
      try {
        await createDiscoveryClient({
          baseUrl: pending.discovery_url,
          signer: await params.signer(),
          signal,
          ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
        }).unlinkClaw(pending.statement);
        params.log.info(`openclaw-id: Discovery unlinked ${label}`);
      } catch (error) {
        if (signal.aborted) {
          return false;
        }
        if (!settles(error)) {
          retry = true;
          params.log.warn(`openclaw-id: unlink of ${label} not sent yet: ${String(error)}`);
          continue;
        }
        // SAFETY: settles() returned true only for a DiscoveryRequestError.
        const code = (error as DiscoveryRequestError).code;
        if (code !== "unlinked") {
          params.log.warn(
            `openclaw-id: Discovery refused the unlink of ${label} (${code}); it will not be sent again`,
          );
        }
      }
      await params.clear(pending.statement);
    }
    return retry;
  };

  // One run sends everything pending, again while more was requested meanwhile, then arms a
  // retry if a send failed. Callers that ask during a run wait for that same run.
  const runOnce = async (): Promise<void> => {
    const signal = lifetime.signal;
    let retry: boolean;
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
      rerun = true;
      return inflight;
    }
    cancelTimer();
    inflight = runOnce().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  return {
    /** Sends every pending unlink now (backoff reset) and keeps retrying until stopped. */
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
