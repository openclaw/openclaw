import { sanitizeForConsole } from "../../agents/console-sanitize.js";
import {
  DEFAULT_CRON_MAX_CONCURRENT_RUNS,
  MAX_CRON_CONCURRENT_RUNS,
} from "../../config/cron-limits.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { readRunFailureCause } from "../../shared/run-failure-notice.js";
import type { CronProviderBackoffSnapshot } from "../store/run-queue.types.js";

const STEP_UP_MS = 60_000;
const MAX_EXTRA_RUNS = MAX_CRON_CONCURRENT_RUNS - DEFAULT_CRON_MAX_CONCURRENT_RUNS;
const log = createSubsystemLogger("cron");

type Reduction = { slots: number; atMs: number };

const backoff = resolveGlobalSingleton(
  Symbol.for("openclaw.cronProviderBackoff"),
  () => ({
    reductions: new Map<string, Reduction>(),
    charges: new Map<string, string | undefined>(),
  }),
  () => resetCronProviderBackoff(),
);

export function resetCronProviderBackoff(): void {
  backoff.reductions.clear();
  backoff.charges.clear();
}

function extraSlots(provider: string, nowMs: number): number {
  const reduction = backoff.reductions.get(provider);
  if (!reduction) {
    return MAX_EXTRA_RUNS;
  }
  const slots = reduction.slots + Math.max(0, Math.floor((nowMs - reduction.atMs) / STEP_UP_MS));
  if (slots >= MAX_EXTRA_RUNS) {
    backoff.reductions.delete(provider);
    return MAX_EXTRA_RUNS;
  }
  return slots;
}

function extraRuns(provider: string): number {
  let count = 0;
  for (const chargedProvider of backoff.charges.values()) {
    if (chargedProvider === provider) {
      count += 1;
    }
  }
  return count;
}

/** The worker applies provider allowances after accounting for receipts that move to default slots. */
export function captureCronProviderBackoff(
  nowMs = Date.now(),
): CronProviderBackoffSnapshot | undefined {
  const allowances = [...backoff.reductions.keys()].flatMap((provider) => {
    const slots = extraSlots(provider, nowMs);
    return slots < MAX_EXTRA_RUNS ? [{ provider, slots }] : [];
  });
  if (allowances.length === 0 && backoff.charges.size === 0) {
    return undefined;
  }
  return {
    allowances,
    charges: [...backoff.charges].map(([receiptId, provider]) => ({ receiptId, provider })),
  };
}

export function releaseCronExtraRunCharge(receiptId: string): void {
  backoff.charges.delete(receiptId);
}

/** A charge follows the receipt's current slot through preflight and runtime fallback. */
export function createCronExtraRunCharge(receiptId: string, extra: boolean) {
  const onGranted = (isExtra: boolean) => {
    if (isExtra) {
      backoff.charges.set(receiptId, backoff.charges.get(receiptId));
    } else {
      releaseCronExtraRunCharge(receiptId);
    }
  };
  onGranted(extra);
  return {
    onGranted,
    tryStart(this: void, provider: string): boolean {
      if (!backoff.charges.has(receiptId) || backoff.charges.get(receiptId) === provider) {
        return true;
      }
      const slots = extraSlots(provider, Date.now());
      if (slots < MAX_EXTRA_RUNS && extraRuns(provider) >= slots) {
        backoff.charges.set(receiptId, undefined);
        return false;
      }
      backoff.charges.set(receiptId, provider);
      return true;
    },
    move(this: void, provider: string) {
      if (backoff.charges.has(receiptId)) {
        backoff.charges.set(receiptId, provider);
      }
    },
    release: () => releaseCronExtraRunCharge(receiptId),
  };
}

function reduceCronRuns(provider: string, reason: "rate_limit" | "overloaded"): void {
  const nowMs = Date.now();
  const slots = extraSlots(provider, nowMs);
  const automation = getCommandLaneSnapshot(CommandLane.CronNested);
  const inFlight = automation.groupActive ?? automation.activeCount;
  const charged = extraRuns(provider);
  if (
    slots < MAX_EXTRA_RUNS &&
    (charged === 0 || charged > slots || inFlight <= DEFAULT_CRON_MAX_CONCURRENT_RUNS)
  ) {
    backoff.reductions.set(provider, { slots, atMs: nowMs });
    return;
  }
  if (inFlight <= DEFAULT_CRON_MAX_CONCURRENT_RUNS) {
    return;
  }
  backoff.reductions.set(provider, { slots: 0, atMs: nowMs });
  log.warn(
    `automation paused extra runs for provider ${sanitizeForConsole(provider)} after it ${reason === "rate_limit" ? "rate-limited a request" : "reported an overload"}; it adds one a minute without pushback`,
  );
}

/** Retries can hide a failed attempt from the final outcome of a conversation or automation. */
export function watchCronProviderPushback(): () => void {
  return onAgentEvent((event) => {
    if (event.stream !== "lifecycle") {
      return;
    }
    const cause = readRunFailureCause(event.data?.errorObservation);
    if (
      cause?.provider &&
      (cause.failoverReason === "rate_limit" || cause.failoverReason === "overloaded")
    ) {
      reduceCronRuns(cause.provider, cause.failoverReason);
    }
  });
}
