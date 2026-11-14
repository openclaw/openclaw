import { channel } from "node:diagnostics_channel";
import { sanitizeForConsole } from "../../agents/console-sanitize.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import type { CronConfig } from "../../config/types.cron.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { readRunFailureCause } from "../../shared/run-failure-notice.js";

/**
 * A step back up needs this long without pushback and since the last step. A little under the
 * scheduler's one-minute look at waiting runs, so each look can take a step.
 */
const GROW_INTERVAL_MS = 50_000;
/** A reduction that nothing has confirmed for this long is forgotten, waiting runs or not. */
const FORGET_AFTER_MS = 60 * 60_000;

const log = createSubsystemLogger("cron");
// Held so the subscription outlives garbage collection of an idle channel.
const memoryCritical = channel("openclaw.memory.critical");

type AdaptiveRunSlots = {
  /** The most runs automation may hold after pushback; absent while the limit is whole. */
  ceiling?: number;
  pushbackAtMs: number;
  grownAtMs: number;
};

// Process-wide, like the provider limits and the memory it reacts to. Not persisted: a restart
// starts from the whole limit and backs off again on the first pushback.
const adaptive = resolveGlobalSingleton(
  Symbol.for("openclaw.cronRunSlotCeiling"),
  (): AdaptiveRunSlots => ({ pushbackAtMs: 0, grownAtMs: 0 }),
  () => resetCronRunSlots(),
);

/** Forgets every reduction: an in-process restart starts from the whole limit. */
export function resetCronRunSlots(): void {
  delete adaptive.ceiling;
  adaptive.pushbackAtMs = adaptive.grownAtMs = 0;
}

/**
 * Run slots automation may hold right now: eight, unless `cron.dynamicConcurrency` is on. Then
 * automation shares the agent concurrency limit with conversations and yields to them, and holds
 * back further after provider or memory pushback, down to the eight it always keeps.
 * Conversations are never held back by automation.
 */
export function resolveCronRunSlots(cron: CronConfig | undefined): number {
  if (cron?.dynamicConcurrency !== true) {
    return DEFAULT_CRON_MAX_CONCURRENT_RUNS;
  }
  if (adaptive.ceiling !== undefined && Date.now() - adaptive.pushbackAtMs >= FORGET_AFTER_MS) {
    delete adaptive.ceiling;
    log.info("automation is back to its whole run limit after an hour without pushback");
  }
  const conversations = getCommandLaneSnapshot(CommandLane.Main);
  const free = conversations.maxConcurrent - conversations.activeCount;
  return Math.max(DEFAULT_CRON_MAX_CONCURRENT_RUNS, Math.min(free, adaptive.ceiling ?? free));
}

/**
 * Pushback while the automation lane holds more agent sessions than automation's floor:
 * automation may hold half as many runs. The sessions already in flight keep retrying, so
 * there is no further reduction until they have come down to the reduced limit; pushback at
 * that level is new evidence and halves again.
 */
function reduceCronRunSlots(cause: string): void {
  adaptive.pushbackAtMs = Date.now();
  const inFlight = getCommandLaneSnapshot(CommandLane.CronNested).activeCount;
  if (inFlight <= DEFAULT_CRON_MAX_CONCURRENT_RUNS || inFlight > (adaptive.ceiling ?? inFlight)) {
    return;
  }
  adaptive.ceiling = Math.max(DEFAULT_CRON_MAX_CONCURRENT_RUNS, Math.floor(inFlight / 2));
  log.warn(
    `automation limited to ${adaptive.ceiling} runs at once after ${cause}; it adds one about every minute while runs wait and nothing pushes back`,
  );
}

/**
 * A run is waiting for a slot while the limit is reduced, and nothing has pushed back for a
 * while: allow one more, until the limit is whole again.
 */
export function growCronRunSlots(): void {
  const { ceiling } = adaptive;
  if (ceiling === undefined) {
    return;
  }
  const conversations = getCommandLaneSnapshot(CommandLane.Main);
  if (ceiling >= conversations.maxConcurrent) {
    // The agent limit came down to the reduced one by config reload.
    delete adaptive.ceiling;
    return;
  }
  const nowMs = Date.now();
  if (
    ceiling >= conversations.maxConcurrent - conversations.activeCount ||
    nowMs - Math.max(adaptive.pushbackAtMs, adaptive.grownAtMs) < GROW_INTERVAL_MS
  ) {
    return;
  }
  adaptive.grownAtMs = nowMs;
  if (ceiling + 1 >= conversations.maxConcurrent) {
    delete adaptive.ceiling;
    log.info("automation is back to its whole run limit");
  } else {
    adaptive.ceiling = ceiling + 1;
    log.info(`automation limit raised to ${ceiling + 1} runs at once`);
  }
}

/**
 * Listens for pushback while a scheduler runs. A model attempt of the embedded runtime or of a
 * plugin harness that a provider rate-limits or turns away as overloaded reports it on the
 * agent event bus, for a conversation or a job and whether or not a retry later succeeds. The
 * diagnostics heartbeat publishes memory pressure while the Gateway process, or one of its
 * workers, is critically short of memory; other owners shed caches and idle workers on the
 * same signal.
 */
export function watchCronRunSlotPushback(): () => void {
  const onMemoryCritical = () => reduceCronRunSlots("critical memory pressure");
  memoryCritical.subscribe(onMemoryCritical);
  const stopAgentEvents = onAgentEvent((event) => {
    if (event.stream !== "lifecycle") {
      return;
    }
    const cause = readRunFailureCause(event.data?.errorObservation);
    if (cause?.failoverReason === "rate_limit" || cause?.failoverReason === "overloaded") {
      reduceCronRunSlots(
        `provider ${sanitizeForConsole(cause.provider) ?? "unknown"} ${cause.failoverReason === "rate_limit" ? "rate-limited a request" : "reported an overload"}`,
      );
    }
  });
  return () => {
    memoryCritical.unsubscribe(onMemoryCritical);
    stopAgentEvents();
  };
}
