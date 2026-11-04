import { describe, expect, it } from "vitest";
import { createQueueCase } from "./queue.case.test-support.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";

installQueueRuntimeErrorSilencer();

describe("followup queue overflow summary context", () => {
  it("replays a request evicted by room events with its own sender context", async () => {
    const q = createQueueCase({ mode: "followup", cap: 2 }, 3);
    const requestContext = {
      text: 'Conversation info:\n{"message_id":"101","sender":{"name":"Ada"}}',
    };
    q.add({
      ...createRun({ prompt: "@bot when is the deploy?" }, { senderId: "ada", senderName: "Ada" }),
      currentInboundContext: requestContext,
    });
    for (const [messageId, sender] of [
      ["102", "Grace"],
      ["103", "Linus"],
    ] as const) {
      q.add({
        ...createRun(
          { prompt: `#${messageId} ${sender}: lunch?`, messageId },
          { senderName: sender },
        ),
        currentInboundEventKind: "room_event",
        currentInboundContext: { text: `[OpenClaw room event] #${messageId} ${sender}` },
      });
    }
    await q.drain();
    expect(
      q.calls.map((run) => [run.prompt, run.run.senderName, run.currentInboundContext]),
    ).toEqual([
      [
        "[Queue overflow] Dropped 1 message due to cap.\nSummary:\n- @bot when is the deploy?",
        "Ada",
        requestContext,
      ],
      ["#102 Grace: lunch?", "Grace", { text: "[OpenClaw room event] #102 Grace" }],
      ["#103 Linus: lunch?", "Linus", { text: "[OpenClaw room event] #103 Linus" }],
    ]);
  });

  it("keeps room-event framing on elided overflow summaries", async () => {
    const q = createQueueCase({ mode: "followup", cap: 1 }, 3);
    for (const messageId of ["201", "202", "203"]) {
      q.add({
        ...createRun({ prompt: `#${messageId} Grace: ambient`, messageId }),
        currentInboundEventKind: "room_event",
        currentInboundContext: { text: `[OpenClaw room event] #${messageId}` },
      });
    }
    await q.drain();
    // #201's summary line is elided when #202 overflows; its retry source must keep the framing.
    expect(
      q.calls.map((run) => [run.prompt, run.currentInboundEventKind, run.currentInboundContext]),
    ).toEqual([
      [
        "[Queue overflow] Dropped 1 message due to cap.\nSummary:\n- #201 Grace: ambient",
        "room_event",
        { text: "[OpenClaw room event] #201" },
      ],
      [
        "[Queue overflow] Dropped 1 message due to cap.\nSummary:\n- #202 Grace: ambient",
        "room_event",
        { text: "[OpenClaw room event] #202" },
      ],
      ["#203 Grace: ambient", "room_event", { text: "[OpenClaw room event] #203" }],
    ]);
  });
});
