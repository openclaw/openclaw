import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "./gateway-suspend-coordinator.js";
import { inspectors } from "./gateway-suspend-coordinator.test-support.js";
import { inspectGatewaySuspensionParticipants } from "./gateway-suspension-participants.js";
import {
  registerGatewaySuspensionParticipant,
  resetGatewaySuspensionParticipantsForTest,
} from "./gateway-suspension-participants.test-support.js";

const SUSPEND_TTL_MS = 2 * 60_000;
const reset = () => {
  resetGatewaySuspensionParticipantsForTest();
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
};
beforeEach(reset);
afterEach(reset);

describe("gateway suspension participant coordination", () => {
  it("awaits queue recovery before completing an in-process lifecycle reset", async () => {
    let finish!: () => void;
    registerGatewaySuspensionParticipant({
      id: "restart-queue",
      prepare: () => ({ activeCount: 0 }),
      status: () => ({ activeCount: 0 }),
      resume: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    const resumeScheduling = vi.fn();
    prepareGatewaySuspend({
      requestId: "restart-recovery",
      pauseScheduling: () => {},
      resumeScheduling,
      inspect: inspectors(),
    });
    markGatewayRestartDraining();
    const recovery = resetGatewaySuspendCoordinatorForLifecycleRestart({ wait: true });
    expect(isGatewayWorkAdmissionClosed()).toBe(true);
    expect(resumeScheduling).not.toHaveBeenCalled();
    finish();
    await recovery;
    expect(resumeScheduling).toHaveBeenCalledOnce();
    resetGatewayWorkAdmission();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("refuses preparation while a plugin participant still owns work", () => {
    const resume = vi.fn();
    registerGatewaySuspensionParticipant({
      id: "delivery-queue",
      prepare: () => ({ activeCount: 2, message: "2 queued plugin deliveries" }),
      status: () => ({ activeCount: 2 }),
      resume,
    });
    const resumeScheduling = vi.fn();

    const result = prepareGatewaySuspend({
      requestId: "request-participant-busy",
      pauseScheduling: vi.fn(),
      resumeScheduling,
      inspect: inspectors(),
    });

    expect(result).toMatchObject({ status: "busy", reason: "active-work", activeCount: 2 });
    expect(result).toMatchObject({
      blockers: [
        {
          kind: "plugin-participant",
          count: 2,
          message: "2 queued plugin deliveries",
          participantId: "delivery-queue",
        },
      ],
    });
    // The refused attempt must leave the participant and the gateway open.
    expect(resume).toHaveBeenCalled();
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("holds an idle participant closed until the suspension resumes", () => {
    const participantResume = vi.fn();
    registerGatewaySuspensionParticipant({
      id: "delivery-queue",
      prepare: () => ({ activeCount: 0 }),
      status: () => ({ activeCount: 0 }),
      resume: participantResume,
    });

    expect(
      prepareGatewaySuspend({
        requestId: "request-participant-idle",
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        inspect: inspectors(),
        createSuspensionId: () => "suspension-participant",
      }),
    ).toMatchObject({ status: "ready", activeCount: 0 });
    expect(participantResume).not.toHaveBeenCalled();
    expect(isGatewayWorkAdmissionClosed()).toBe(true);

    expect(resumeGatewaySuspend("suspension-participant")).toMatchObject({ resumed: true });

    expect(participantResume).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it.each(["throws", "invalid"])("retains a %s prepare failure throughout drain", (failure) => {
    registerGatewaySuspensionParticipant({
      id: "unfenced-queue",
      prepare: () => {
        if (failure === "throws") {
          throw new Error("not fenced");
        }
        return { activeCount: Number.NaN };
      },
      status: () => ({ activeCount: 0 }),
      resume: () => {},
    });
    expect(
      prepareGatewaySuspend({
        requestId: "failed-fence",
        drain: true,
        pauseScheduling: () => {},
        resumeScheduling: () => {},
        inspect: inspectors({ getPluginParticipants: inspectGatewaySuspensionParticipants }),
        createSuspensionId: () => "failed-fence",
      }).status,
    ).toBe("draining");
    expect(getGatewaySuspendStatus("failed-fence").status).toBe("draining");
    expect(isGatewayWorkAdmissionClosed()).toBe(true);
  });

  it("counts an unregistered queue until its held work drains", () => {
    let activeCount = 1;
    const unregister = registerGatewaySuspensionParticipant({
      id: "detached-queue",
      prepare: () => ({ activeCount }),
      status: () => ({ activeCount }),
      resume: () => {},
    });
    expect(
      prepareGatewaySuspend({
        requestId: "detached",
        drain: true,
        pauseScheduling: () => {},
        resumeScheduling: () => {},
        inspect: inspectors({ getPluginParticipants: inspectGatewaySuspensionParticipants }),
        createSuspensionId: () => "detached",
      }).status,
    ).toBe("draining");
    unregister();
    expect(getGatewaySuspendStatus("detached").status).toBe("draining");
    activeCount = 0;
    expect(getGatewaySuspendStatus("detached").status).toBe("ready");
  });

  it.each([false, true])("rejects new queues behind a held lease (drain: %s)", (drain) => {
    prepareGatewaySuspend({
      requestId: "late-registration",
      drain,
      pauseScheduling: () => {},
      resumeScheduling: () => {},
      inspect: inspectors({ getQueueSize: () => Number(drain) }),
    });
    expect(() =>
      registerGatewaySuspensionParticipant({
        id: "late-queue",
        prepare: () => ({ activeCount: 0 }),
        status: () => ({ activeCount: 0 }),
        resume: () => {},
      }),
    ).toThrow(/admission is closed/);
  });

  it("keeps admission closed until asynchronous queue recovery completes", async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const resume = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      registerGatewaySuspensionParticipant({
        id: "async-queue",
        prepare: () => ({ activeCount: 0 }),
        status: () => ({ activeCount: 0 }),
        resume,
      });
      prepareGatewaySuspend({
        requestId: "async-resume",
        pauseScheduling: () => {},
        resumeScheduling: () => {},
        inspect: inspectors(),
        createSuspensionId: () => "async-resume",
      });
      expect(resumeGatewaySuspend("async-resume")).toMatchObject({
        ok: false,
        reason: "scheduler-resume-failed",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(resume).toHaveBeenCalledOnce();
      finish();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reopens a participant at lease expiry without any polling", () => {
    vi.useFakeTimers();
    try {
      const participantResume = vi.fn();
      registerGatewaySuspensionParticipant({
        id: "delivery-queue",
        prepare: () => ({ activeCount: 0 }),
        status: () => ({ activeCount: 0 }),
        resume: participantResume,
      });
      prepareGatewaySuspend({
        requestId: "request-participant-expiry",
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        inspect: inspectors(),
        createSuspensionId: () => "suspension-participant-expiry",
      });

      vi.advanceTimersByTime(SUSPEND_TTL_MS);

      expect(participantResume).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays fail-closed when a participant cannot reopen", () => {
    registerGatewaySuspensionParticipant({
      id: "delivery-queue",
      prepare: () => ({ activeCount: 0 }),
      status: () => ({ activeCount: 0 }),
      resume: () => {
        throw new Error("queue unavailable");
      },
    });
    prepareGatewaySuspend({
      requestId: "request-participant-recovery",
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
      inspect: inspectors(),
      createSuspensionId: () => "suspension-participant-recovery",
      warn: vi.fn(),
    });

    expect(resumeGatewaySuspend("suspension-participant-recovery")).toMatchObject({
      ok: false,
      reason: "scheduler-resume-failed",
    });
    // Admission must not reopen over a participant that is still fenced.
    expect(isGatewayWorkAdmissionClosed()).toBe(true);
  });
});
