import { sanitizeForConsole } from "../../agents/console-sanitize.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import type { CronConfig } from "../../config/types.cron.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { readRunFailureCause } from "../../shared/run-failure-notice.js";

/** After pushback the ceiling climbs back by one run per this much time without pushback. */
const STEP_UP_MS = 60_000;

const log = createSubsystemLogger("cron");

type Reduction = { ceiling: number; atMs: number };

// Process-wide, like the provider limits it reacts to. Not persisted: a restart starts from the
// whole limit and backs off again on the first pushback.
const pushback = resolveGlobalSingleton(
  Symbol.for("openclaw.cronRunSlotCeiling"),
  (): { reduction?: Reduction } => ({}),
  () => resetCronRunSlots(),
);

/** Forgets every reduction: an in-process restart starts from the whole limit. */
export function resetCronRunSlots(): void {
  delete pushback.reduction;
}

/** The most runs automation may hold after pushback, or undefined when nothing has pushed back. */
function currentCeiling(nowMs: number): number | undefined {
  const { reduction } = pushback;
  return reduction && reduction.ceiling + Math.floor((nowMs - reduction.atMs) / STEP_UP_MS);
}

/**
 * Run slots automation may hold right now: eight, unless `cron.dynamicConcurrency` is on. Then
 * automation shares the agent concurrency limit with conversations and yields to them, and holds
 * back further after provider pushback, down to the eight it always keeps.
 * Conversations are never held back by automation.
 */
export function resolveCronRunSlots(cron: CronConfig | undefined): number {
  if (cron?.dynamicConcurrency !== true) {
    return DEFAULT_CRON_MAX_CONCURRENT_RUNS;
  }
  const conversations = getCommandLaneSnapshot(CommandLane.Main);
  const free = conversations.maxConcurrent - conversations.activeCount;
  return Math.max(
    DEFAULT_CRON_MAX_CONCURRENT_RUNS,
    Math.min(free, currentCeiling(Date.now()) ?? free),
  );
}

/**
 * Pushback while the automation lane holds more agent sessions than eight: automation may hold
 * half as many runs. The sessions already in flight keep retrying, so while they exceed the
 * ceiling their pushback holds it where it is instead of halving it again; pushback once they
 * have come down to it is new evidence and halves again. Pushback that cannot lower a reduced
 * ceiling, at eight sessions or fewer, also holds it, so each step up follows a quiet minute.
 */
function reduceCronRunSlots(cause: string): void {
  const nowMs = Date.now();
  const ceiling = currentCeiling(nowMs);
  const inFlight = getCommandLaneSnapshot(CommandLane.CronNested).activeCount;
  if (
    ceiling !== undefined &&
    (inFlight > ceiling || inFlight <= DEFAULT_CRON_MAX_CONCURRENT_RUNS)
  ) {
    pushback.reduction = { ceiling, atMs: nowMs };
    return;
  }
  if (inFlight <= DEFAULT_CRON_MAX_CONCURRENT_RUNS) {
    return;
  }
  const reduced = Math.max(DEFAULT_CRON_MAX_CONCURRENT_RUNS, Math.floor(inFlight / 2));
  pushback.reduction = { ceiling: reduced, atMs: nowMs };
  log.warn(
    `automation limited to ${reduced} runs at once after ${cause}; it adds one a minute while nothing pushes back`,
  );
}

/**
 * Listens for pushback while a scheduler runs. A model attempt of the embedded runtime or of a
 * plugin harness that a provider rate-limits or turns away as overloaded reports it on the
 * agent event bus, for a conversation or a job and whether or not a retry later succeeds.
 */
export function watchCronRunSlotPushback(): () => void {
  return onAgentEvent((event) => {
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
}
