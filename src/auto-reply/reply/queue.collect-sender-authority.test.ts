import { expect, it, vi } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import { createChannelAdmissionAudit } from "../../channels/message-access/admission-evidence.js";
import { createQueueCase } from "./queue.case.test-support.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { getExistingFollowupQueue } from "./queue/state.js";

installQueueRuntimeErrorSilencer();

it("keeps an owner's evidence-backed message out of a guest batch that lacks evidence (#203463)", async () => {
  const audit = createChannelAdmissionAudit({ enabled: true });
  try {
    const q = createQueueCase();
    q.add(
      createRun(
        {
          prompt: "guest message without evidence",
          originatingChannel: "slack",
          originatingTo: "channel:A",
        },
        { senderId: "guest-1", senderIsOwner: false },
      ),
    );
    q.add(
      createRun(
        {
          prompt: "owner message",
          originatingChannel: "slack",
          originatingTo: "channel:A",
          channelAdmissionEvidence: createChannelParticipantAdmissionEvidence({
            audit,
            channelId: "slack",
            accountId: "default",
            participantId: "owner-1",
          }),
        },
        { senderId: "owner-1", senderIsOwner: true },
      ),
    );
    await q.drain();
    await vi.waitFor(() => expect(getExistingFollowupQueue(q.key)).toBeUndefined());

    const guestCalls = q.calls.filter((call) =>
      call.prompt.includes("guest message without evidence"),
    );
    expect(guestCalls).toHaveLength(1);
    expect(guestCalls[0]?.prompt).not.toContain("owner message");
    expect(guestCalls[0]?.run).toMatchObject({ senderId: "guest-1", senderIsOwner: false });
  } finally {
    audit.close();
  }
});
