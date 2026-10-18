import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import type { GatewayScheduler } from "./gateway-scheduler.js";
import { UpdateCampaignController } from "./update-campaign.js";

type CampaignState = NonNullable<ReturnType<UpdateCampaignController["getState"]>>;
const packageTarget = { kind: "package" as const, version: "2.0.0" };
const randomUUIDMock = vi.hoisted(() => vi.fn());

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: () => randomUUIDMock(),
  };
});

function createInspectors(
  readBusy: () => number,
  overrides: Partial<GatewayActiveWorkInspectors> = {},
): GatewayActiveWorkInspectors {
  return {
    getQueueSize: readBusy,
    getPendingReplies: () => 0,
    getEmbeddedRuns: () => 0,
    getBackgroundExecSessions: () => 0,
    getCronRuns: () => 0,
    getAgentRuns: () => 0,
    getAcpRuns: () => 0,
    getMediaRuns: () => 0,
    getRootRequests: () => 0,
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
    ...overrides,
  };
}

describe("UpdateCampaignController", () => {
  let clock: ReturnType<typeof createGatewaySchedulerClock>;
  let scheduler: GatewayScheduler;
  let controller: UpdateCampaignController;
  let apply: ReturnType<typeof vi.fn<() => Promise<"applied">>>;
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    let nextId = 0;
    randomUUIDMock.mockReset();
    randomUUIDMock.mockImplementation(() => `campaign-${++nextId}`);
    clock = createGatewaySchedulerClock(1_000_000);
    scheduler = createTestGatewayScheduler(clock.clock);
    controller = new UpdateCampaignController(scheduler);
    apply = vi.fn(async () => "applied" as const);
    onChange = vi.fn();
  });

  afterEach(async () => {
    await scheduler.stop();
  });

  function expectState(state: CampaignState["state"], fields: Partial<CampaignState> = {}) {
    expect(controller.getState()).toMatchObject({ state, ...fields });
  }
  function announce(options: Partial<Parameters<UpdateCampaignController["announce"]>[0]> = {}) {
    controller.announce({
      target: packageTarget,
      inspect: createInspectors(() => 0),
      apply,
      onChange,
      ...options,
    });
  }

  it("keeps the countdown deadline absolute across a clock rollback and applies once", async () => {
    announce();

    expectState("countdown", { applyAtMs: 1_060_000, forceAtMs: 1_900_000 });
    await clock.advanceBy(59_000);
    clock.setTime(1_050_000);
    await clock.wake();
    expect(apply).not.toHaveBeenCalled();
    await clock.advanceBy(10_000);
    expectState("applying");
    expect(apply).toHaveBeenCalledWith({ forced: false, target: packageTarget });
    await clock.advanceBy(5 * 60_000);
    expect(apply).toHaveBeenCalledOnce();
  });

  it("ignores open terminals while persistence and queue work still delay countdown", async () => {
    let queueSize = 0;
    let terminalPersistence = 1;

    announce({
      inspect: createInspectors(() => queueSize, {
        getTerminalPersistence: () => terminalPersistence,
        getTerminalSessions: () => 2,
      }),
    });
    expectState("waiting-for-idle");

    terminalPersistence = 0;
    queueSize = 1;
    clock.setTime(900_000);
    await clock.wake();
    expectState("waiting-for-idle");
    queueSize = 0;
    await clock.advanceBy(5_000);
    expectState("countdown");

    await clock.advanceBy(60_000);
    expectState("applying");
    expect(apply).toHaveBeenCalledWith({ forced: false, target: packageTarget });
  });

  it("keeps an announced countdown stable when active work begins", async () => {
    let busy = 0;

    announce({
      target: { kind: "git", upstreamRef: "origin/main", upstreamSha: "one", commitsBehind: 1 },
      inspect: createInspectors(() => busy),
    });
    const applyAtMs = controller.getState()?.applyAtMs;
    busy = 1;
    await clock.advanceBy(5_000);
    expectState("countdown", { applyAtMs });

    await clock.advanceBy(55_000);
    expectState("applying");
    expect(apply).toHaveBeenCalledWith({
      forced: false,
      target: { kind: "git", upstreamRef: "origin/main", upstreamSha: "one", commitsBehind: 1 },
    });
  });

  it("starts a fresh campaign for a newer target and clears availability", () => {
    const inspect = createInspectors(() => 1);

    announce({ inspect });
    const first = controller.getState();
    clock.setTime(1_010_000);
    announce({ target: { kind: "package", version: "3.0.0" }, inspect });

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

  it("lets update.run adopt a campaign without invoking automatic apply", async () => {
    expect(controller.adopt()).toEqual({ status: "absent" });
    announce();
    expect(controller.adopt()).toEqual({
      status: "adopted",
      campaignId: "campaign-1",
      target: packageTarget,
    });
    expectState("applying");
    expect(controller.hold()).toBe(false);
    await clock.advanceBy(15 * 60_000);
    expect(apply).not.toHaveBeenCalled();
  });

  it("keeps a different Git upstream waiting after mismatched adoption", () => {
    const target = {
      kind: "git" as const,
      upstreamRef: "origin/main",
      upstreamSha: "frozen-sha",
      commitsBehind: 3,
    };
    const matching = {
      mode: "tracked" as const,
      upstreamRef: "origin/main",
      upstreamSha: "frozen-sha",
    };
    const requested = { ...matching, upstreamRef: "upstream/main" };
    announce({ target, inspect: createInspectors(() => 1) });

    expect(controller.adopt(requested)).toEqual({ status: "mismatch" });
    expectState("waiting-for-idle", { id: "campaign-1" });
    expect(onChange).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();

    expect(controller.adopt(matching)).toMatchObject({
      status: "adopted",
      campaignId: "campaign-1",
      target,
    });
    expectState("applying");
  });

  it("keeps an applying campaign unchanged for a conflicting adoption", async () => {
    announce({
      target: {
        kind: "git",
        upstreamRef: "origin/main",
        upstreamSha: "frozen-sha",
        commitsBehind: 3,
      },
    });
    await clock.advanceBy(60_000);
    const transitionCount = onChange.mock.calls.length;
    const requestedTarget = {
      mode: "tracked" as const,
      upstreamRef: "origin/main",
      upstreamSha: "different-sha",
    };

    expect(controller.adopt(requestedTarget)).toEqual({ status: "applying" });
    expectState("applying", { id: "campaign-1" });
    expect(onChange).toHaveBeenCalledTimes(transitionCount);
    expect(apply).toHaveBeenCalledOnce();
  });

  it("holds a waiting campaign once and shifts its hard deadline", async () => {
    announce({
      inspect: createInspectors(() => 1),
    });

    expect(controller.hold()).toBe(true);
    expectState("waiting-for-idle", {
      holdUntilMs: 4_600_000,
      forceAtMs: 5_500_000,
      updatedAtMs: 1_000_000,
    });
    expect(controller.getState()?.applyAtMs).toBeUndefined();
    expect(controller.hold()).toBe(false);

    await clock.advanceBy(60 * 60_000);
    expectState("waiting-for-idle", { holdUntilMs: 4_600_000 });
    expect(controller.hold()).toBe(false);
    expect(scheduler.nextWakeAtMs).toBe(4_605_000);
    expect(apply).not.toHaveBeenCalled();
    await clock.advanceBy(15 * 60_000);
    expectState("applying");
    expect(apply).toHaveBeenCalledWith({ forced: true, target: packageTarget });
  });

  it("holds a countdown, drops its apply deadline, and allows adoption", async () => {
    announce();
    expectState("countdown");

    expect(controller.hold(10_000)).toBe(true);
    expectState("waiting-for-idle", { holdUntilMs: 1_010_000, forceAtMs: 1_910_000 });
    expect(controller.getState()?.applyAtMs).toBeUndefined();
    await clock.advanceBy(9_999);
    expectState("waiting-for-idle");
    expect(apply).not.toHaveBeenCalled();

    expect(controller.adopt()).toMatchObject({
      status: "adopted",
      campaignId: "campaign-1",
      target: packageTarget,
    });
    expectState("applying");
    await clock.advanceBy(20 * 60_000);
    expect(apply).not.toHaveBeenCalled();
  });

  it("preserves a consumed hold while returning to countdown without spinning timers", async () => {
    announce();
    expect(controller.hold(10_000)).toBe(true);

    await clock.advanceBy(10_000);
    expectState("countdown", { holdUntilMs: 1_010_000, applyAtMs: 1_070_000 });
    expect(controller.hold()).toBe(false);
    expect(scheduler.nextWakeAtMs).toBe(1_015_000);
    expect(apply).not.toHaveBeenCalled();
  });

  it("clears a failed apply and lets the next announcement start fresh", async () => {
    const announcement = { apply: vi.fn(async () => "failed" as const) };
    announce(announcement);
    await clock.advanceBy(60_000);

    expect(controller.getState()).toBeUndefined();
    expect(onChange).toHaveBeenLastCalledWith(undefined);

    announce(announcement);
    expectState("countdown", { id: "campaign-2" });
  });

  it("keeps the applying campaign owner when a newer target is announced", async () => {
    const firstApply = vi.fn(async () => "handoff" as const);
    const nextApply = vi.fn(async () => "handoff" as const);
    const inspect = createInspectors(() => 0);
    announce({ inspect, apply: firstApply });
    await clock.advanceBy(60_000);
    const applying = controller.getState();
    onChange.mockClear();

    announce({ target: { kind: "package", version: "3.0.0" }, inspect, apply: nextApply });
    await clock.advanceBy(15 * 60_000);

    expect(controller.getState()).toEqual(applying);
    expect(onChange).not.toHaveBeenCalled();
    expect(firstApply).toHaveBeenCalledOnce();
    expect(nextApply).not.toHaveBeenCalled();
    controller.clear();
  });

  it("does not clear a replacement campaign when an earlier apply fails", async () => {
    const applying = createDeferredCore();
    const outcome = createDeferredCore<"failed">();
    const pendingApply = vi.fn(() => {
      applying.resolve();
      return outcome.promise;
    });

    announce({ apply: pendingApply });
    const wake = clock.advanceBy(60_000);
    try {
      await applying.promise;
      expectState("applying", { id: "campaign-1" });

      controller.clear();
      announce({ target: { kind: "package", version: "3.0.0" } });
      expectState("countdown", { id: "campaign-2" });
    } finally {
      outcome.resolve("failed");
      await wake;
    }
    expectState("countdown", { id: "campaign-2" });
  });
});
