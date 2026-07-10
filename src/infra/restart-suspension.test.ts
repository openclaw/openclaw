// Pins scheduled restart ordering against the reversible host-suspension fence.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import {
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForTest,
  resumeGatewaySuspend,
} from "./gateway-suspend-coordinator.js";
import { scheduleGatewaySigusr1Restart, testing } from "./restart.js";

function inspectors(): GatewayActiveWorkInspectors {
  return {
    getQueueSize: () => 0,
    getPendingReplies: () => 0,
    getEmbeddedRuns: () => 0,
    getCronRuns: () => 0,
    getActiveTasks: () => 0,
    getTaskBlockers: () => [],
    getRootRequests: () => getActiveGatewayRootWorkCount(),
    getSessionAdmissions: () => 0,
    getSessionMutations: () => 0,
    getChatRuns: () => 0,
    getQueuedTurns: () => 0,
    getTerminalPersistence: () => 0,
    getTerminalSessions: () => 0,
  };
}

function countSigusr1Emits(calls: readonly unknown[][]): number {
  return calls.filter((args) => args[0] === "SIGUSR1").length;
}

describe("scheduled restart during gateway suspension", () => {
  const sigusr1Handler = () => {};

  beforeEach(() => {
    testing.resetSigusr1State();
    resetGatewayWorkAdmission();
    resetGatewaySuspendCoordinatorForTest();
    vi.useFakeTimers();
    process.on("SIGUSR1", sigusr1Handler);
  });

  afterEach(() => {
    process.removeListener("SIGUSR1", sigusr1Handler);
    resetGatewaySuspendCoordinatorForTest();
    resetGatewayWorkAdmission();
    testing.resetSigusr1State();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("defers a previously scheduled restart until a ready suspension resumes", async () => {
    const emitSpy = vi.spyOn(process, "emit");
    scheduleGatewaySigusr1Restart({
      delayMs: 1_000,
      reason: "config.patch",
      skipCooldown: true,
    });

    const prepared = prepareGatewaySuspend({
      requestId: "request-restart-delay",
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
      inspect: inspectors(),
      createSuspensionId: () => "suspension-restart-delay",
    });
    expect(prepared.status).toBe("ready");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(countSigusr1Emits(emitSpy.mock.calls)).toBe(0);

    expect(resumeGatewaySuspend("suspension-restart-delay")).toMatchObject({
      ok: true,
      resumed: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(countSigusr1Emits(emitSpy.mock.calls)).toBe(1);
  });

  it("reports active work while a due restart is preparing to emit", async () => {
    const emitSpy = vi.spyOn(process, "emit");
    let releasePreparation: () => void = () => {};
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    scheduleGatewaySigusr1Restart({
      delayMs: 0,
      reason: "config.patch",
      skipCooldown: true,
      emitHooks: {
        beforeEmit: async () => preparation,
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    const prepared = prepareGatewaySuspend({
      requestId: "request-restart-preparing",
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
      inspect: inspectors(),
    });
    expect(prepared).toMatchObject({
      status: "busy",
      reason: "active-work",
      counts: { rootRequests: 1 },
    });
    expect(countSigusr1Emits(emitSpy.mock.calls)).toBe(0);

    releasePreparation();
    await vi.advanceTimersByTimeAsync(0);
    expect(countSigusr1Emits(emitSpy.mock.calls)).toBe(1);

    expect(
      prepareGatewaySuspend({
        requestId: "request-after-restart-signal",
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        inspect: inspectors(),
      }),
    ).toMatchObject({
      status: "busy",
      reason: "gateway-draining",
    });
  });
});
