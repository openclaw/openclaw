import { sanitizeForConsole } from "../../agents/console-sanitize.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS } from "../../config/cron-limits.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { readCgroupMemoryHeadroomBytes, readHostFreeMemoryBytes } from "../../infra/host-memory.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readHostExecMemory } from "../../process/child-memory.js";
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
 * Run slots automation may hold right now. Automation shares the agent concurrency limit with
 * conversations and yields to them, and holds back further after provider pushback, down to the
 * eight it always keeps. Conversations are never held back by automation. Memory can lower this
 * further, down to one; see {@link resolveCronMemoryRunSlots}.
 */
export function resolveCronRunSlots(): number {
  const conversations = getCommandLaneSnapshot(CommandLane.Main);
  const free = conversations.maxConcurrent - conversations.activeCount;
  return Math.min(
    Math.max(DEFAULT_CRON_MAX_CONCURRENT_RUNS, Math.min(free, currentCeiling(Date.now()) ?? free)),
    resolveCronMemoryRunSlots(),
  );
}

/**
 * The least memory one automation run is taken to use: its agent session, model streams, and the
 * tool processes it starts. When a recent exec command held more, that is the figure instead.
 */
const RUN_MEMORY_BYTES = 256 * 1024 * 1024;

/**
 * Runs that fit in half of the memory open to automation, at the per-run figure; at least one, so
 * automation always progresses, and runs already going are never stopped. Open memory is what is
 * free plus what running exec commands hold, so it does not depend on how many runs are going:
 * runs that just started, whose commands have not shown up as used yet, cannot use up the other
 * half however many times the queue is drained before they do.
 *
 * Host memory counts reclaimable cache as free. Under a cgroup v2 memory limit, open memory is
 * what the cgroup has left, so processes sharing the Gateway's container count against it too;
 * inactive file cache counts as free, since the kernel reclaims it before killing anything. Where
 * those files cannot be read, as on cgroup v1, the limit minus the Gateway's own memory stands in,
 * which does not see other processes. Commands also stay within the exec memory budget, past
 * which the exec guard kills them.
 *
 * Accepted edge case: after a quiet period no recent command sets the figure, so a burst whose
 * commands are much larger than 256 MiB can still exceed the exec budget. The exec guard then
 * stops the largest command with an error naming the budget.
 */
function resolveCronMemoryRunSlots(): number {
  const exec = readHostExecMemory();
  const commands = exec?.usedBytes ?? 0;
  const cgroupHeadroom = readCgroupMemoryHeadroomBytes();
  const limit = process.constrainedMemory();
  const open = Math.min(
    readHostFreeMemoryBytes() + commands,
    cgroupHeadroom !== undefined
      ? cgroupHeadroom + commands
      : limit > 0
        ? limit - process.memoryUsage.rss()
        : Infinity,
    exec ? exec.budgetBytes : Infinity,
  );
  const perRun = Math.max(RUN_MEMORY_BYTES, exec?.largestCommandBytes ?? 0);
  return Math.max(1, Math.floor(open / 2 / perRun));
}

/**
 * Pushback while automation and the hook turns sharing its budget hold more agent sessions than
 * eight: automation may hold half as many runs. The sessions already in flight keep retrying, so
 * while they exceed the ceiling their pushback holds it where it is instead of halving it again;
 * pushback once they have come down to it is new evidence and halves again. Pushback that cannot
 * lower a reduced ceiling, at eight sessions or fewer, also holds it, so each step up follows a
 * quiet minute.
 */
function reduceCronRunSlots(cause: string): void {
  const nowMs = Date.now();
  const ceiling = currentCeiling(nowMs);
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
