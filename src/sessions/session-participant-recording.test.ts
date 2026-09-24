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
import { recordSessionParticipantBestEffort } from "./session-participant-recording.js";

const { recordParticipant } = vi.hoisted(() => ({
  recordParticipant: vi.fn<() => Promise<"inserted">>(),
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  recordSessionParticipant: recordParticipant,
}));

beforeEach(() => {
  resetGatewayWorkAdmission();
  recordParticipant.mockReset();
});
afterEach(resetGatewayWorkAdmission);

const target = {
  identity: { type: "profile" as const, id: "viewer" },
  agentId: "main",
  sessionKey: "agent:main:participant",
  storePath: "/synthetic/participant.sqlite",
  promptedAt: 1,
};

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
      let drained = false;
      const drainage = work.drain().then(() => {
        drained = true;
      });
      await Promise.resolve();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(drained).toBe(false);
      const failure = new Error("Participant persistence failed");
      if (outcome === "reject") {
        persistence.reject(failure);
      } else {
        persistence.resolve("inserted");
      }
      await drainage;
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
