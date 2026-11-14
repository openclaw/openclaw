import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { DEFAULT_CRON_MAX_CONCURRENT_RUNS as BUDGET } from "../config/cron-limits.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import { CommandLane } from "../process/lanes.js";
import { applyGatewayLaneConcurrency, resolveGatewayLaneConcurrency } from "./server-lanes.js";

const cronSnapshot = () => getCommandLaneSnapshot(CommandLane.CronNested);
const hookSnapshot = () => getCommandLaneSnapshot(CommandLane.HookDispatch);
const publish = (enabled: boolean) =>
  applyGatewayLaneConcurrency(
    resolveGatewayLaneConcurrency(enabled ? { hooks: { enabled: true, token: "t" } } : {}),
  );

function park(lane: string) {
  const gate = createDeferred();
  const run = enqueueCommandInLane(lane, async () => await gate.promise, { warnAfterMs: 10_000 });
  return { run, release: gate.resolve };
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

afterEach(async () => {
  const { resetSessionSuspensionStateForTest } =
    await import("../agents/session-suspension.test-support.js");
  resetSessionSuspensionStateForTest();
  resetCommandQueueStateForTest();
});

it.each([false, true])(
  "disabling hooks releases only idle capacity (active hook: %s)",
  async (activeHook) => {
    publish(true);
    const hook = activeHook ? park(CommandLane.HookDispatch) : undefined;
    const cron = Array.from({ length: BUDGET }, () => park(CommandLane.CronNested));
    await settle();
    expect(cronSnapshot()).toMatchObject({
      activeCount: BUDGET - 1,
      queuedCount: 1,
      ...(activeHook ? {} : { blockedBy: "sibling-reservation" }),
    });
    if (hook) {
      expect(hookSnapshot().groupActive).toBe(BUDGET);
    }
    publish(false);
    await settle();

    let lateHookStarted = false;
    let lateHook: Promise<void> | undefined;
    if (hook) {
      expect(hookSnapshot()).toMatchObject({
        maxConcurrent: 0,
        group: "cron-hooks",
        reservedForLane: 0,
        activeCount: 1,
      });
      expect(cronSnapshot()).toMatchObject({
        activeCount: BUDGET - 1,
        queuedCount: 1,
        groupActive: BUDGET,
      });
      lateHook = enqueueCommandInLane(CommandLane.HookDispatch, async () => {
        lateHookStarted = true;
      });
      await settle();
      expect(lateHookStarted).toBe(false);
      expect(hookSnapshot().queuedCount).toBe(1);
      hook.release();
      await hook.run;
      await settle();
      expect(cronSnapshot().groupActive).toBe(BUDGET);
      expect(lateHookStarted).toBe(false);
    } else {
      expect(cronSnapshot().group).toBeUndefined();
    }
    expect(cronSnapshot()).toMatchObject({ activeCount: BUDGET, queuedCount: 0 });
    cron.forEach((task) => task.release());
    await Promise.all(cron.map((task) => task.run));
    if (hook) {
      publish(true);
      await lateHook;
      expect(lateHookStarted).toBe(true);
    } else {
      expect(cronSnapshot().blockedBy).toBeNull();
    }
  },
);
