import { sanitizeForConsole } from "../../agents/console-sanitize.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
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

// Process-wide, like the provider limits it reacts to. Not persisted: a restart starts with the
// extra runs open and backs off again on the first pushback.
const pushback = resolveGlobalSingleton(
  Symbol.for("openclaw.cronProviderBackoff"),
  (): { reduction?: Reduction } => ({}),
  () => resetCronProviderBackoff(),
);

/** Forgets every reduction: an in-process restart starts with the extra runs open. */
export function resetCronProviderBackoff(): void {
  delete pushback.reduction;
}

/**
 * The most runs automation may hold after provider pushback, or undefined when nothing has pushed
 * back. Pushback takes away the runs past the eight default slots; each minute without pushback
 * gives one back. The default slots never count against it; see `cron.drainQueue`.
 */
export function cronRunCeilingAfterPushback(nowMs = Date.now()): number | undefined {
  const { reduction } = pushback;
  return reduction && reduction.ceiling + Math.floor((nowMs - reduction.atMs) / STEP_UP_MS);
}

/**
 * Pushback while automation and the hook turns sharing its budget hold more agent sessions than
 * the eight default slots: automation stops adding runs past them. The sessions already in flight
 * keep retrying, so while they exceed the ceiling their pushback holds it where it is; pushback
 * once they have come down to it drops it to eight again. Pushback that cannot lower a reduced
 * ceiling, at eight sessions or fewer, also holds it, so each step up follows a quiet minute.
 */
function reduceCronRuns(cause: string): void {
  const nowMs = Date.now();
  const ceiling = cronRunCeilingAfterPushback(nowMs);
  // Hook turns run in their own lane but share automation's budget and its providers; while
  // hooks are on, the group's count includes them.
  const automation = getCommandLaneSnapshot(CommandLane.CronNested);
  const inFlight = automation.groupActive ?? automation.activeCount;
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
  pushback.reduction = { ceiling: DEFAULT_CRON_MAX_CONCURRENT_RUNS, atMs: nowMs };
  log.warn(
    `automation limited to ${DEFAULT_CRON_MAX_CONCURRENT_RUNS} runs at once after ${cause}; it adds one a minute while nothing pushes back`,
  );
}

/**
 * Listens for pushback while a scheduler runs. A model attempt of the embedded runtime or of a
 * plugin harness that a provider rate-limits or turns away as overloaded reports it on the
 * agent event bus, for a conversation or a job and whether or not a retry later succeeds.
 */
export function watchCronProviderPushback(): () => void {
  return onAgentEvent((event) => {
    if (event.stream !== "lifecycle") {
      return;
    }
    const cause = readRunFailureCause(event.data?.errorObservation);
    if (cause?.failoverReason === "rate_limit" || cause?.failoverReason === "overloaded") {
      reduceCronRuns(
        `provider ${sanitizeForConsole(cause.provider) ?? "unknown"} ${cause.failoverReason === "rate_limit" ? "rate-limited a request" : "reported an overload"}`,
      );
    }
  });
}
