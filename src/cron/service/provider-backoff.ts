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

const STEP_UP_MS = 60_000;
const MAX_EXTRA_RUNS = MAX_CRON_CONCURRENT_RUNS - DEFAULT_CRON_MAX_CONCURRENT_RUNS;
const log = createSubsystemLogger("cron");

type Reduction = { slots: number; atMs: number };

const backoff = resolveGlobalSingleton(
  Symbol.for("openclaw.cronProviderBackoff"),
  () => ({ reductions: new Map<string, Reduction>(), charges: new Map<string, number>() }),
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
  return backoff.charges.get(provider) ?? 0;
}

function blocksExtraRun(provider: string, nowMs: number): boolean {
  const slots = extraSlots(provider, nowMs);
  return slots < MAX_EXTRA_RUNS && extraRuns(provider) >= slots;
}

/** Worker drains use the snapshot to pass over parked runs during extra-slot selection. */
export function blockedCronExtraRunProviders(nowMs = Date.now()): string[] {
  return [...backoff.reductions.keys()].filter((provider) => blocksExtraRun(provider, nowMs));
}

/** One charge follows a run's extra slot. A fallback can move an existing charge unconditionally. */
export function createCronExtraRunCharge() {
  let provider: string | undefined;
  const move = (next: string | undefined) => {
    if (provider === next) {
      return;
    }
    if (provider !== undefined) {
      const remaining = extraRuns(provider) - 1;
      if (remaining > 0) {
        backoff.charges.set(provider, remaining);
      } else {
        backoff.charges.delete(provider);
      }
    }
    provider = next;
    if (next !== undefined) {
      backoff.charges.set(next, extraRuns(next) + 1);
    }
  };
  return {
    tryCharge(next: string): boolean {
      if (provider !== next && blocksExtraRun(next, Date.now())) {
        return false;
      }
      move(next);
      return true;
    },
    move,
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
