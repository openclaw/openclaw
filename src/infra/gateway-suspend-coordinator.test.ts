// Covers atomic refuse-only suspension preparation, renewal, and release.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.js";
import {
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import {
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "./gateway-suspend-coordinator.js";

function inspectors(
  overrides: Partial<GatewayActiveWorkInspectors> = {},
): GatewayActiveWorkInspectors {
  return {
    getQueueSize: () => 0,
    getPendingReplies: () => 0,
    getEmbeddedRuns: () => 0,
    getBackgroundExecSessions: () => 0,
    getCronRuns: () => 0,
    getActiveTasks: () => 0,
    getTaskBlockers: () => [],
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

beforeEach(() => {
  resetProcessRegistryForTests();
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
});

afterEach(() => {
  resetProcessRegistryForTests();
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
});

describe("gateway suspend coordinator", () => {
  it("lifecycle reset resumes a held scheduler before admission is cleared", () => {
    const resumeScheduling = vi.fn(() => {
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
    });
    expect(
      prepareGatewaySuspend({
        requestId: "request-lifecycle-reset",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors(),
      }),
    ).toMatchObject({ status: "ready" });

    markGatewayRestartDraining();
    expect(resumeScheduling).not.toHaveBeenCalled();
    expect(isGatewayWorkAdmissionClosed()).toBe(true);

    resetGatewaySuspendCoordinatorForLifecycleRestart();

    expect(resumeScheduling).toHaveBeenCalledOnce();
    resetGatewayWorkAdmission();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("test reset resumes a held scheduler before admission is cleared", () => {
    const resumeScheduling = vi.fn(() => {
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
    });
    expect(
      prepareGatewaySuspend({
        requestId: "request-lifecycle-reset",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors(),
      }),
    ).toMatchObject({ status: "ready" });

    resetGatewaySuspendCoordinatorForLifecycleRestart();
    resetGatewayWorkAdmission();

    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("reopens admission in the same turn when active work refuses preparation", () => {
    const events: string[] = [];
    const result = prepareGatewaySuspend({
      requestId: "request-busy",
      pauseScheduling: () => events.push("pause"),
      resumeScheduling: () => events.push("resume"),
      inspect: inspectors({
        getQueueSize: () => {
          events.push("inspect");
          return 1;
        },
      }),
    });

    expect(result.status).toBe("busy");
    expect(events).toEqual(["pause", "inspect", "resume"]);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("keeps admission closed until a failed busy rollback resumes scheduling", () => {
    vi.useFakeTimers();
    try {
      const resumeScheduling = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("timer unavailable");
        })
        .mockImplementationOnce(() => {});
      const first = prepareGatewaySuspend({
        requestId: "request-busy-resume-retry",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors({ getQueueSize: () => 1 }),
      });

      expect(first).toEqual({
        status: "recovering",
        reason: "scheduler-resume-failed",
        retryAfterMs: 1_000,
      });
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(getGatewaySuspendStatus("stale-id")).toEqual(first);
      expect(resumeGatewaySuspend("stale-id")).toEqual({
        ok: false,
        reason: "scheduler-resume-failed",
        retryAfterMs: 1_000,
      });
      expect(
        prepareGatewaySuspend({
          requestId: "request-before-scheduler-resume",
          pauseScheduling: vi.fn(),
          resumeScheduling,
          inspect: inspectors(),
        }),
      ).toEqual(first);

      vi.advanceTimersByTime(1_000);
      expect(resumeScheduling).toHaveBeenCalledTimes(2);
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
      expect(getGatewaySuspendStatus("stale-id")).toEqual({ status: "running" });

      expect(
        prepareGatewaySuspend({
          requestId: "request-after-scheduler-resume",
          pauseScheduling: vi.fn(),
          resumeScheduling,
          inspect: inspectors(),
          createSuspensionId: () => "suspension-after-scheduler-resume",
        }),
      ).toMatchObject({
        status: "ready",
        suspensionId: "suspension-after-scheduler-resume",
      });
      vi.advanceTimersByTime(1_000);
      expect(resumeScheduling).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels scheduler recovery when restart supersedes suspension", () => {
    vi.useFakeTimers();
    try {
      const resumeScheduling = vi.fn(() => {
        throw new Error("timer unavailable");
      });
      expect(
        prepareGatewaySuspend({
          requestId: "request-recovery-restart",
          pauseScheduling: vi.fn(),
          resumeScheduling,
          inspect: inspectors({ getQueueSize: () => 1 }),
        }),
      ).toMatchObject({ status: "recovering" });

      markGatewayRestartDraining();
      vi.advanceTimersByTime(1_000);

      expect(resumeScheduling).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(getGatewaySuspendStatus("stale-id")).toEqual({ status: "running" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns recovery when inspection fails before admission commits", () => {
    vi.useFakeTimers();
    try {
      const resumeScheduling = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("timer unavailable");
        })
        .mockImplementationOnce(() => {});
      const result = prepareGatewaySuspend({
        requestId: "request-inspection-failure",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors({
          getQueueSize: () => {
            throw new Error("inspection failed");
          },
        }),
      });

      expect(result).toMatchObject({ status: "recovering" });
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      vi.advanceTimersByTime(1_000);
      expect(resumeScheduling).toHaveBeenCalledTimes(2);
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets restart supersede a suspension without reopening its scheduler", () => {
    const resumeScheduling = vi.fn();
    const result = prepareGatewaySuspend({
      requestId: "request-restart",
      pauseScheduling: vi.fn(),
      resumeScheduling,
      inspect: inspectors(),
      createSuspensionId: () => "suspension-restart",
    });
    expect(result.status).toBe("ready");

    markGatewayRestartDraining();

    expect(getGatewaySuspendStatus("suspension-restart")).toEqual({ status: "running" });
    expect(resumeScheduling).not.toHaveBeenCalled();
    expect(isGatewayWorkAdmissionClosed()).toBe(true);
  });

  it("exposes scheduler recovery after a ready lease cannot resume", () => {
    vi.useFakeTimers();
    try {
      const resumeScheduling = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("timer unavailable");
        })
        .mockImplementationOnce(() => {});
      prepareGatewaySuspend({
        requestId: "request-resume-retry",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors(),
        createSuspensionId: () => "suspension-resume-retry",
      });

      expect(resumeGatewaySuspend("suspension-resume-retry")).toMatchObject({
        ok: false,
        reason: "scheduler-resume-failed",
      });
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(getGatewaySuspendStatus("suspension-resume-retry")).toMatchObject({
        status: "recovering",
      });
      expect(
        prepareGatewaySuspend({
          requestId: "request-resume-retry",
          pauseScheduling: vi.fn(),
          resumeScheduling,
          inspect: inspectors(),
        }),
      ).toMatchObject({ status: "recovering" });
      expect(resumeGatewaySuspend("suspension-resume-retry")).toMatchObject({
        ok: false,
        reason: "scheduler-resume-failed",
      });

      vi.advanceTimersByTime(1_000);
      expect(resumeScheduling).toHaveBeenCalledTimes(2);
      expect(getGatewaySuspendStatus("suspension-resume-retry")).toEqual({ status: "running" });
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
