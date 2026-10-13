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
  it("does not personalize an empty batch", () => {
    expect(collectRuntimeMetadata([]).personalBootstrapEligible).toBeUndefined();
  });

  it("preserves the session profile but removes mixed-participant sender authority", async () => {
    const selectedProfile = "session-owner";
    const audit = createChannelAdmissionAudit({ enabled: true });
    const key = "personal-bootstrap-collect";
    const { calls, done, runFollowup } = createDrainRecorder();
    const settings = createQueueSettings();
    try {
      for (const [index, participantId] of ["alice", "bob"].entries()) {
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
        run.channelAdmissionEvidence = createChannelParticipantAdmissionEvidence({
          audit,
          channelId: "slack",
          participantId,
        });
        enqueueFollowupRun(key, run, settings);
      }
      scheduleFollowupDrain(key, runFollowup);
      await done.promise;
      expect(calls).toHaveLength(1);
      expect(calls[0]?.run.bootstrapUserProfileId).toBe(selectedProfile);
      expect(calls[0]?.personalBootstrapEligible).toBe(true);
      expect(calls[0]?.run).toMatchObject({
        senderId: undefined,
        senderIsOwner: false,
        traceAuthorized: false,
      });
    } finally {
      clearFollowupQueue(key);
      audit.close();
    }
  });
});
