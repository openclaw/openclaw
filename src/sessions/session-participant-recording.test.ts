import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  getActiveGatewayRootWorkCount,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  recordSessionParticipantBestEffort,
  waitForSessionParticipantRecording,
} from "./session-participant-recording.js";

const { recordParticipant, warnParticipant } = vi.hoisted(() => ({
  recordParticipant: vi.fn<() => Promise<"inserted">>(),
  warnParticipant: vi.fn(),
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  recordSessionParticipant: recordParticipant,
}));

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: warnParticipant,
    }),
  };
});

beforeEach(() => {
  resetGatewayWorkAdmission();
  recordParticipant.mockReset();
  warnParticipant.mockReset();
});
afterEach(resetGatewayWorkAdmission);

const target = {
  identity: { type: "profile" as const, id: "viewer" },
  agentId: "main",
  sessionKey: "agent:main:participant",
  storePath: "/synthetic/participant.sqlite",
  promptedAt: 1,
};

it("reports best-effort persistence failure when the caller supplies no reporter", async () => {
  recordParticipant.mockRejectedValue(new Error("synthetic participant write failure"));
  recordSessionParticipantBestEffort(target);
  await waitForSessionParticipantRecording(target);
  expect(warnParticipant).toHaveBeenCalledExactlyOnceWith(
    "failed to record session participant: Error: synthetic participant write failure",
  );
});

it("reports persistence failure outside its caller's still-active Gateway root", async () => {
  const root = tryBeginGatewayRootWorkAdmission("test:participant-reporter");
  if (!root) {
    throw new Error("Participant fixture could not acquire its root");
  }
  const reportedActiveRoots: number[] = [];
  recordParticipant.mockRejectedValue(new Error("synthetic participant write failure"));
  try {
    await root.run(async () => {
      recordSessionParticipantBestEffort({
        ...target,
        onError: () => {
          reportedActiveRoots.push(getActiveGatewayRootWorkCount({ excludeCurrent: true }));
        },
      });
      await waitForSessionParticipantRecording(target);
      expect(reportedActiveRoots).toEqual([1]);
    });
  } finally {
    root.release();
  }
});

it.each(["resolve", "reject"] as const)(
  "joins participant persistence without retaining its caller root when it %ss",
  async (outcome) => {
    const persistence = createDeferredCore<"inserted">();
    const started = createDeferredCore();
    const failures = new Set<unknown>();
    const reported: unknown[] = [];
    const work = new AsyncWorkScope(failures);
    const root = tryBeginGatewayRootWorkAdmission("test:participant");
    if (!root) {
      throw new Error("Participant fixture could not acquire its root");
    }
    recordParticipant.mockImplementation(() => {
      started.resolve();
      return persistence.promise;
    });
    try {
      await root.run(async () => {
        work.run(() => {
          expect(
            recordSessionParticipantBestEffort({
              ...target,
              onError: (error) => reported.push(error),
            }),
          ).toBeUndefined();
          expect(recordParticipant).not.toHaveBeenCalled();
        });
      });
      root.release();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      await started.promise;
      let joined = false;
      const joinedRecording = waitForSessionParticipantRecording(target).then(() => {
        joined = true;
      });
      let drained = false;
      const drainage = work.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(drained).toBe(false);
      expect(joined).toBe(false);
      const failure = new Error("Participant persistence failed");
      if (outcome === "reject") {
        persistence.reject(failure);
      } else {
        persistence.resolve("inserted");
      }
      await drainage;
      await joinedRecording;
      expect(joined).toBe(true);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(reported).toEqual(outcome === "reject" ? [failure] : []);
      expect(failures.size).toBe(0);
    } finally {
      persistence.resolve("inserted");
      await work.drain();
      root.release();
    }
  },
);

it("keeps unrooted participant work unrooted while Gateway admission is closed", async () => {
  const persistence = createDeferredCore<"inserted">();
  const started = createDeferredCore();
  const work = new AsyncWorkScope();
  recordParticipant.mockImplementation(() => {
    started.resolve();
    return persistence.promise;
  });
  markGatewayRestartDraining();
  try {
    work.run(() => recordSessionParticipantBestEffort(target));
    await started.promise;
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(isGatewayWorkAdmissionClosed()).toBe(true);
  } finally {
    persistence.resolve("inserted");
    await work.drain();
  }
});
