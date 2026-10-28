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

function participantRoot() {
  const root = tryBeginGatewayRootWorkAdmission("test:participant");
  if (!root) {
    throw new Error("Participant fixture could not acquire its root");
  }
  return Object.assign(root, { [Symbol.dispose]: () => root.release() });
}

class PendingRecording {
  persistence = createDeferredCore<"inserted">();
  started = createDeferredCore();
  failures = new Set<unknown>();
  work = new AsyncWorkScope(this.failures);
  constructor() {
    recordParticipant.mockImplementation(() => {
      this.started.resolve();
      return this.persistence.promise;
    });
  }
  async [Symbol.asyncDispose]() {
    this.persistence.resolve("inserted");
    await this.work.drain();
  }
}

it.each([false, true])(
  "reports persistence failure with a caller-owned reporter: %s",
  async (rooted) => {
    using root = rooted ? participantRoot() : undefined;
    const reportedActiveRoots: number[] = [];
    recordParticipant.mockRejectedValue(new Error("synthetic participant write failure"));
    const record = async () => {
      const onError = rooted
        ? () => reportedActiveRoots.push(getActiveGatewayRootWorkCount({ excludeCurrent: true }))
        : undefined;
      void recordSessionParticipantBestEffort({ ...target, onError });
      await waitForSessionParticipantRecording(target);
    };
    if (root) {
      await root.run(record);
      expect(reportedActiveRoots).toEqual([1]);
    } else {
      await record();
      expect(warnParticipant).toHaveBeenCalledExactlyOnceWith(
        "failed to record session participant: Error: synthetic participant write failure",
      );
    }
  },
);

it.each(["resolve", "reject"] as const)(
  "joins participant persistence without retaining its caller root when it %ss",
  async (outcome) => {
    using root = participantRoot();
    await using fixture = new PendingRecording();
    const { persistence, started, failures, work } = fixture;
    const reported: unknown[] = [];
    await root.run(async () =>
      work.run(() => {
        void recordSessionParticipantBestEffort({
          ...target,
          onError: (error) => reported.push(error),
        });
        expect(recordParticipant).not.toHaveBeenCalled();
      }),
    );
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
    expect({ drained, joined }).toEqual({ drained: false, joined: false });
    const failure = new Error("Participant persistence failed");
    if (outcome === "reject") {
      persistence.reject(failure);
    } else {
      persistence.resolve("inserted");
    }
    await drainage;
    await joinedRecording;
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(reported).toEqual(outcome === "reject" ? [failure] : []);
    expect(failures.size).toBe(0);
  },
);

it("keeps unrooted participant work unrooted while Gateway admission is closed", async () => {
  await using fixture = new PendingRecording();
  markGatewayRestartDraining();
  fixture.work.run(() => {
    void recordSessionParticipantBestEffort(target);
  });
  await fixture.started.promise;
  expect(getActiveGatewayRootWorkCount()).toBe(0);
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
});
