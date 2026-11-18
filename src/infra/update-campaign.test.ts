import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { GatewayScheduler } from "./gateway-scheduler.js";
import { inspectors } from "./gateway-suspend-coordinator.test-support.js";
import { UpdateCampaignController } from "./update-campaign.js";

const randomUUIDMock = vi.hoisted(() => vi.fn());

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: () => randomUUIDMock(),
  };
});

describe("UpdateCampaignController", () => {
  let clock: ReturnType<typeof createGatewaySchedulerClock>;
  let scheduler: GatewayScheduler;

  beforeEach(() => {
    let nextId = 0;
    randomUUIDMock.mockReset();
    randomUUIDMock.mockImplementation(() => `campaign-${++nextId}`);
    clock = createGatewaySchedulerClock(1_000_000);
    scheduler = createTestGatewayScheduler(clock.clock);
  });

  afterEach(async () => {
    await scheduler.stop();
  });

  const packageTarget = (version = "2.0.0") => ({ kind: "package" as const, version });
  const gitTarget = {
    kind: "git" as const,
    upstreamRef: "origin/main",
    upstreamSha: "frozen-sha",
    commitsBehind: 3,
  };
  function fixture() {
    const controller = new UpdateCampaignController(scheduler);
    const apply = vi.fn(async () => "applied" as const);
    const onChange = vi.fn();
    const announce = (options: Partial<Parameters<typeof controller.announce>[0]> = {}) =>
      controller.announce({
        target: packageTarget(),
        inspect: inspectors({ getQueueSize: () => 0 }),
        apply,
        onChange,
        ...options,
      });
    const expectApply = (forced = false, target = packageTarget()) =>
      expect(apply).toHaveBeenCalledWith({ forced, target });
    return { controller, apply, onChange, announce, expectApply };
  }

  it("keeps the countdown deadline absolute across a clock rollback and applies once", async () => {
    const { controller, apply, announce, expectApply } = fixture();
    announce();

    expect(controller.getState()).toMatchObject({
      state: "countdown",
      applyAtMs: 1_060_000,
      forceAtMs: 1_900_000,
    });
    await clock.advanceBy(59_000);
    clock.setTime(1_050_000);
    await clock.wake();
    expect(apply).not.toHaveBeenCalled();
    await clock.advanceBy(10_000);
    expect(controller.getState()?.state).toBe("applying");
    expectApply();
    await clock.advanceBy(5 * 60_000);
    expect(apply).toHaveBeenCalledOnce();
  });

  it("ignores open terminals while persistence and queue work still delay countdown", async () => {
    const { controller, announce, expectApply } = fixture();
    let queueSize = 0;
    let terminalPersistence = 1;
    announce({
      inspect: inspectors({
        getQueueSize: () => queueSize,
        getTerminalPersistence: () => terminalPersistence,
        getTerminalSessions: () => 2,
      }),
    });
    expect(controller.getState()?.state).toBe("waiting-for-idle");

    terminalPersistence = 0;
    queueSize = 1;
    clock.setTime(900_000);
    await clock.wake();
    expect(controller.getState()?.state).toBe("waiting-for-idle");
    queueSize = 0;
    await clock.advanceBy(5_000);
    expect(controller.getState()?.state).toBe("countdown");

    await clock.advanceBy(60_000);
    expect(controller.getState()?.state).toBe("applying");
    expectApply();
  });

  it("keeps an announced countdown stable when active work begins", async () => {
    const { controller, apply, announce } = fixture();
    let busy = 0;
    announce({
      target: { kind: "git", upstreamRef: "origin/main", upstreamSha: "one", commitsBehind: 1 },
      inspect: inspectors({ getQueueSize: () => busy }),
    });
    const applyAtMs = controller.getState()?.applyAtMs;
    busy = 1;
    await clock.advanceBy(5_000);
    expect(controller.getState()).toMatchObject({ state: "countdown", applyAtMs });

    await clock.advanceBy(55_000);
    expect(controller.getState()?.state).toBe("applying");
    expect(apply).toHaveBeenCalledWith({
      forced: false,
      target: { kind: "git", upstreamRef: "origin/main", upstreamSha: "one", commitsBehind: 1 },
    });
  });

  it("starts a fresh campaign for a newer target and clears availability", () => {
    const { controller, onChange, announce } = fixture();
    const inspect = inspectors({ getQueueSize: () => 1 });
    announce({ inspect });
    const first = controller.getState();
    clock.setTime(1_010_000);
    announce({ target: packageTarget("3.0.0"), inspect });

    expect(controller.getState()).toMatchObject({
      id: "campaign-2",
      announcedAtMs: 1_010_000,
      forceAtMs: 1_910_000,
    });
    expect(controller.getState()?.id).not.toBe(first?.id);
    controller.clear();
    expect(controller.getState()).toBeUndefined();
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("keeps a different Git upstream waiting after mismatched adoption", () => {
    const { controller, apply, onChange, announce } = fixture();
    const matching = {
      mode: "tracked" as const,
      upstreamRef: "origin/main",
      upstreamSha: "frozen-sha",
    };
    announce({
      target: gitTarget,
      inspect: inspectors({ getQueueSize: () => 1 }),
    });

    expect(controller.adopt({ ...matching, upstreamRef: "upstream/main" })).toEqual({
      status: "mismatch",
    });
    expect(controller.getState()).toMatchObject({ id: "campaign-1", state: "waiting-for-idle" });
    expect(onChange).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();

    expect(controller.adopt(matching)).toMatchObject({
      status: "adopted",
      campaignId: "campaign-1",
      target: gitTarget,
    });
    expect(controller.getState()?.state).toBe("applying");
  });

  it("keeps an applying campaign unchanged for a conflicting adoption", async () => {
    const { controller, apply, onChange, announce } = fixture();
    announce({ target: gitTarget });
    await clock.advanceBy(60_000);
    const transitionCount = onChange.mock.calls.length;
    const requestedTarget = {
      mode: "tracked" as const,
      upstreamRef: "origin/main",
      upstreamSha: "different-sha",
    };

    expect(controller.adopt(requestedTarget)).toEqual({ status: "applying" });
    expect(controller.getState()).toMatchObject({ id: "campaign-1", state: "applying" });
    expect(onChange).toHaveBeenCalledTimes(transitionCount);
    expect(apply).toHaveBeenCalledOnce();
  });

  it("holds a waiting campaign once and shifts its hard deadline", async () => {
    const { controller, apply, announce, expectApply } = fixture();
    announce({
      inspect: inspectors({ getQueueSize: () => 1 }),
    });

    expect(controller.hold()).toBe(true);
    expect(controller.getState()).toMatchObject({
      state: "waiting-for-idle",
      holdUntilMs: 4_600_000,
      forceAtMs: 5_500_000,
      updatedAtMs: 1_000_000,
    });
    expect(controller.getState()?.applyAtMs).toBeUndefined();
    expect(controller.hold()).toBe(false);

    await clock.advanceBy(60 * 60_000);
    expect(controller.getState()).toMatchObject({
      state: "waiting-for-idle",
      holdUntilMs: 4_600_000,
    });
    expect(controller.hold()).toBe(false);
    expect(scheduler.nextWakeAtMs).toBe(4_605_000);
    expect(apply).not.toHaveBeenCalled();
    await clock.advanceBy(15 * 60_000);
    expect(controller.getState()?.state).toBe("applying");
    expectApply(true);
  });

  it("holds a countdown, drops its apply deadline, and allows adoption", async () => {
    const { controller, apply, announce } = fixture();
    expect(controller.adopt()).toEqual({ status: "absent" });
    announce();
    expect(controller.getState()?.state).toBe("countdown");

    expect(controller.hold(10_000)).toBe(true);
    expect(controller.getState()).toMatchObject({
      state: "waiting-for-idle",
      holdUntilMs: 1_010_000,
      forceAtMs: 1_910_000,
    });
    expect(controller.getState()?.applyAtMs).toBeUndefined();
    await clock.advanceBy(9_999);
    expect(controller.getState()?.state).toBe("waiting-for-idle");
    expect(apply).not.toHaveBeenCalled();

    expect(controller.adopt()).toEqual({
      status: "adopted",
      campaignId: "campaign-1",
      target: packageTarget(),
    });
    expect(controller.getState()?.state).toBe("applying");
    expect(controller.hold()).toBe(false);
    await clock.advanceBy(20 * 60_000);
    expect(apply).not.toHaveBeenCalled();
  });

  it("preserves a consumed hold while returning to countdown without spinning timers", async () => {
    const { controller, apply, announce } = fixture();
    announce();
    expect(controller.hold(10_000)).toBe(true);

    await clock.advanceBy(10_000);
    expect(controller.getState()).toMatchObject({
      state: "countdown",
      holdUntilMs: 1_010_000,
      applyAtMs: 1_070_000,
    });
    expect(controller.hold()).toBe(false);
    expect(scheduler.nextWakeAtMs).toBe(1_015_000);
    expect(apply).not.toHaveBeenCalled();
  });

  it("clears a failed apply and lets the next announcement start fresh", async () => {
    const { controller, onChange, announce } = fixture();
    const announcement = { apply: vi.fn(async () => "failed" as const) };

    announce(announcement);
    await clock.advanceBy(60_000);

    expect(controller.getState()).toBeUndefined();
    expect(onChange).toHaveBeenLastCalledWith(undefined);

    announce(announcement);
    expect(controller.getState()).toMatchObject({ id: "campaign-2", state: "countdown" });
  });

  it("keeps the applying campaign owner when a newer target is announced", async () => {
    const { controller, onChange, announce } = fixture();
    const firstApply = vi.fn(async () => "handoff" as const);
    const nextApply = vi.fn(async () => "handoff" as const);
    announce({ apply: firstApply });
    await clock.advanceBy(60_000);
    const applying = controller.getState();
    onChange.mockClear();

    announce({ target: packageTarget("3.0.0"), apply: nextApply });
    await clock.advanceBy(15 * 60_000);

    expect(controller.getState()).toEqual(applying);
    expect(onChange).not.toHaveBeenCalled();
    expect(firstApply).toHaveBeenCalledOnce();
    expect(nextApply).not.toHaveBeenCalled();
    controller.clear();
  });

  it("does not clear a replacement campaign when an earlier apply fails", async () => {
    const { controller, announce } = fixture();
    const applying = createDeferredCore();
    const outcome = createDeferredCore<"failed">();
    const apply = vi.fn(() => {
      applying.resolve();
      return outcome.promise;
    });

    announce({ apply });
    const wake = clock.advanceBy(60_000);
    try {
      await applying.promise;
      expect(controller.getState()).toMatchObject({ id: "campaign-1", state: "applying" });

      controller.clear();
      announce({ target: packageTarget("3.0.0") });
      expect(controller.getState()).toMatchObject({ id: "campaign-2", state: "countdown" });
    } finally {
      outcome.resolve("failed");
      await wake;
    }
    expect(controller.getState()).toMatchObject({ id: "campaign-2", state: "countdown" });
  });
});
