import { enableSessionSuspensionWritesForGatewayStart } from "../agents/session-suspension.js";
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { resolveCronMaxConcurrentRuns } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getCommandLaneSnapshot,
  publishLaneConfiguration,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

type GatewayLaneConcurrency = {
  cron: number;
  /** Zero disables hooks without reserving any of the cron budget. */
  hookDispatch: number;
  main: number;
  subagent: number;
};

/** Capacity held inside the cron budget so hook dispatch cannot be starved. */
const HOOK_DISPATCH_LANE_RESERVATION = 1;

/** Group bounding cron inner work and hook dispatch to one shared budget. */
const CRON_HOOK_LANE_GROUP = "cron-hooks";

export function resolveGatewayLaneConcurrency(cfg: OpenClawConfig): GatewayLaneConcurrency {
  const cron = resolveCronMaxConcurrentRuns();
  return {
    cron,
    // The reservation guarantees one slot, but hooks may use every free slot
    // inside the shared budget. A one-wide lane would serialize unrelated hooks.
    hookDispatch: cfg.hooks?.enabled === true ? cron : 0,
    main: resolveAgentMaxConcurrent(cfg),
    subagent: resolveSubagentMaxConcurrent(cfg),
  };
}

export function applyGatewayLaneConcurrency(
  concurrency: GatewayLaneConcurrency,
  opts: { gatewayStart?: boolean } = {},
): void {
  if (opts.gatewayStart) {
    enableSessionSuspensionWritesForGatewayStart();
  }
  // Resolution is deliberately separate: this commit-edge applier only updates
  // live queue state and cannot reject a config midway through publication.
  setCommandLaneConcurrency(CommandLane.Cron, concurrency.cron);
  // Publish both lanes and their shared budget atomically; individual setters
  // could dispatch each lane's full width before the group exists.
  const hooksEnabled = concurrency.hookDispatch > 0;
  const hookSnapshot = getCommandLaneSnapshot(CommandLane.HookDispatch);
  // Closing hooks must not detach already-running hook work from the shared
  // budget while cron immediately expands back to its full width. Retain the
  // group without a reservation until a later publication sees no active hook.
  const retainInFlightHookBudget = !hooksEnabled && hookSnapshot.activeCount > 0;
  publishLaneConfiguration({
    lanes: {
      [CommandLane.CronNested]: concurrency.cron,
      [CommandLane.HookDispatch]: concurrency.hookDispatch,
    },
    groups:
      hooksEnabled || retainInFlightHookBudget
        ? {
            [CRON_HOOK_LANE_GROUP]: {
              budget: concurrency.cron,
              members: [CommandLane.CronNested, CommandLane.HookDispatch],
              reservations: hooksEnabled
                ? { [CommandLane.HookDispatch]: HOOK_DISPATCH_LANE_RESERVATION }
                : undefined,
            },
          }
        : undefined,
    clearGroups: hooksEnabled || retainInFlightHookBudget ? undefined : [CRON_HOOK_LANE_GROUP],
  });
  setCommandLaneConcurrency(CommandLane.Main, concurrency.main);
  if (opts.gatewayStart) {
    // sessions.send work uses a shared nested lane with no config knob.
    setCommandLaneConcurrency(CommandLane.Nested, 1);
  }
  setCommandLaneConcurrency(CommandLane.Subagent, concurrency.subagent);
  // Recall can be awaited while its parent holds a main or subagent slot.
  // Keep a separate, finite helper budget shared by every agent and session.
  setCommandLaneConcurrency(CommandLane.ActiveMemory, concurrency.subagent);
}
