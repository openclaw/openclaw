import { describe, expect, it } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import { createChannelAdmissionAudit } from "../../channels/message-access/admission-evidence.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";
import {
  createQueueTestRun,
  createQueueSettings,
  createDrainRecorder,
} from "./queue.test-helpers.js";
import { collectRuntimeMetadata } from "./queue/delivery-context.js";
import { clearFollowupQueue } from "./queue/state.js";

describe("session personal bootstrap in collected turns", () => {
  it.each([false, undefined])(
    "does not personalize a batch with ineligible source %s",
    (eligible) => {
      const external = createQueueTestRun({ prompt: "human request" });
      external.personalBootstrapEligible = true;
      const internal = createQueueTestRun({ prompt: "internal event" });
      internal.personalBootstrapEligible = eligible;
      expect(
        collectRuntimeMetadata([external, internal]).personalBootstrapEligible,
      ).toBeUndefined();
      expect(collectRuntimeMetadata([]).personalBootstrapEligible).toBeUndefined();
    },
  );

  it.each([
    { kind: "same participant", secondParticipant: "alice", selectedProfile: "session-owner" },
    { kind: "different participants", secondParticipant: "bob", selectedProfile: "session-owner" },
    { kind: "unknown participant", secondParticipant: undefined, selectedProfile: "session-owner" },
    { kind: "no human session owner", secondParticipant: "bob", selectedProfile: undefined },
  ])(
    "preserves the source turn's session profile with $kind",
    async ({ kind, secondParticipant, selectedProfile }) => {
      const audit = createChannelAdmissionAudit({ enabled: true });
      const key = `personal-bootstrap-collect-${kind}`;
      const { calls, done, runFollowup } = createDrainRecorder();
      const settings = createQueueSettings();
      try {
        for (const [index, participantId] of ["alice", secondParticipant].entries()) {
          const run = createQueueTestRun({
            prompt: "queued message",
            originatingChannel: "slack",
            originatingTo: "channel:A",
          });
          // Pending turns may predate reassignment. Collection carries the selected
          // source's session profile; execution refreshes it from persisted ownership.
          run.personalBootstrapEligible = true;
          run.run.bootstrapUserProfileId = index === 0 ? "previous-session-owner" : selectedProfile;
          run.run.senderId = "shared-transport";
          run.run.senderIsOwner = true;
          run.run.traceAuthorized = true;
          if (participantId) {
            run.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
              audit,
              channelId: "slack",
              participantId,
            });
          }
          enqueueFollowupRun(key, run, settings);
        }
        scheduleFollowupDrain(key, runFollowup);
        await done.promise;
        expect(calls).toHaveLength(1);
        expect(calls[0]?.run.bootstrapUserProfileId).toBe(selectedProfile);
        expect(calls[0]?.personalBootstrapEligible).toBe(true);
        if (kind === "different participants" || kind === "no human session owner") {
          // Personal context is not sender authority: mixed verified callers still
          // lose the source sender's privileges under the existing collection rule.
          expect(calls[0]?.run).toMatchObject({
            senderId: undefined,
            senderIsOwner: false,
            traceAuthorized: false,
          });
        }
      } finally {
        clearFollowupQueue(key);
        audit.close();
      }
    },
  );
});
