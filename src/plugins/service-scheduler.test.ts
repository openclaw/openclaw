import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createPluginServiceScheduler } from "./service-scheduler.js";

function fixture() {
  const time = createGatewaySchedulerClock(1_000);
  const gateway = createTestGatewayScheduler(time.clock);
  return { time, gateway, owner: createPluginServiceScheduler(gateway).scheduler };
}

describe("plugin service scheduling", () => {
  it("replaces IDs only within their service or child lifetime", async () => {
    const { time, gateway, owner } = fixture();
    const { scheduler: sibling } = createPluginServiceScheduler(gateway);
    const child = owner.scope();
    const seen: string[] = [];
    const schedule = (scope: typeof owner, name: string) =>
      scope.schedule({
        id: "refresh",
        delayMs: 100,
        run: () => {
          seen.push(name);
        },
      });
    schedule(owner, "replaced");
    schedule(sibling, "sibling");
    schedule(child, "child");
    schedule(owner, "owner");
    await time.advanceBy(100);
    expect(seen.toSorted()).toEqual(["child", "owner", "sibling"]);
    await Promise.all([owner.stop(), sibling.stop(), gateway.stop()]);
  });

  it("joins replaced running descendant work before its parent closes", async () => {
    const { time, gateway, owner } = fixture();
    const child = owner.scope();
    const descendant = child.scope();
    const work = createDeferredCore();
    const completed = vi.fn();
    const late = vi.fn();
    descendant.schedule({
      id: "refresh",
      delayMs: 0,
      everyMs: 100,
      run: async () => {
        await work.promise;
        completed();
      },
    });
    const wake = time.wake();
    descendant.schedule({ id: "refresh", delayMs: 0, run: late });
    child.schedule({ id: "waiting", delayMs: 100, run: late });
    const stopped = vi.fn();
    const stopping = owner.stop().then(stopped);
    expect([owner, child, descendant].every((scope) => scope.signal.aborted)).toBe(true);
    expect(completed).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
    work.resolve();
    await Promise.all([wake, stopping, owner.stop()]);
    expect(completed).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledOnce();
    await time.advanceBy(1_000);
    expect(late).not.toHaveBeenCalled();
    await gateway.stop();
  });

  it("rejects retained handles after owner closure while siblings keep running", async () => {
    const { time, gateway, owner } = fixture();
    const child = owner.scope();
    const sibling = owner.scope();
    const run = vi.fn();
    const retainedSchedule = child.schedule;
    const retainedScope = child.scope;
    sibling.schedule({ id: "refresh", delayMs: 100, run });
    await child.stop();
    expect(() => retainedSchedule({ id: "refresh", delayMs: 0, run })).toThrow("closed");
    expect(retainedScope).toThrow("closed");
    await time.advanceBy(100);
    expect(run).toHaveBeenCalledOnce();
    await gateway.stop();
    expect(() => sibling.schedule({ id: "refresh", delayMs: 0, run })).toThrow("closed");
    expect(owner.scope).toThrow("closed");
    await owner.stop();
  });
});
