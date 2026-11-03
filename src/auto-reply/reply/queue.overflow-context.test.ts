import { describe, expect, it, vi } from "vitest";
import { createInboundEventDeliveryCorrelation } from "../../plugin-sdk/inbound-event-delivery.js";
import { createQueueCase } from "./queue.case.test-support.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";

installQueueRuntimeErrorSilencer();

describe("followup queue overflow summary context", () => {
  it("replays a request evicted by other requests with its own sender context", async () => {
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
        currentInboundContext: { text: `Request #${messageId} ${sender}` },
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
      ["#102 Grace: lunch?", "Grace", { text: "Request #102 Grace" }],
      ["#103 Linus: lunch?", "Linus", { text: "Request #103 Linus" }],
    ]);
  });

  it.each(["summarize", "old", "new"] as const)(
    "sheds ambient overflow before requests without replay turns with drop:%s",
    async (dropPolicy) => {
      const q = createQueueCase({ mode: "followup", cap: 2, dropPolicy }, 2);
      const request = createRun({ prompt: "@bot deploy?", messageId: "request" });
      const lifecycles = [0, 1].map(() => ({
        onAdopted: vi.fn(),
        onAbandoned: vi.fn(),
        onSettled: vi.fn(),
      }));
      const abandoned = lifecycles.map((lifecycle) => lifecycle.onAbandoned);
      const correlation = createInboundEventDeliveryCorrelation({
        targetsMatch: (a, b) => a === b,
      });
      const activeDelivered = vi.fn();
      const event = { outboundTo: "room", markInboundEventDelivered: activeDelivered };
      const options = { inboundEventKind: "room_event" };
      const endActive = correlation.begin(q.key, event, options);
      const beginDiscarded = vi.fn(() =>
        correlation.begin(q.key, { ...event, markInboundEventDelivered: vi.fn() }, options),
      );
      const ambient = createRun({
        prompt: "lunch?",
        messageId: "ambient",
        currentInboundEventKind: "room_event",
        turnAdoptionLifecycle: lifecycles[0],
        deliveryCorrelations: [{ begin: beginDiscarded }],
        onQueueDisposition: vi.fn(),
      });
      q.add(request);
      q.add(ambient);
      q.add(createRun({ prompt: "@bot status?", messageId: "second" }));
      const incoming = createRun({
        ...ambient,
        messageId: "incoming",
        controllerInput: undefined,
        turnAdoptionLifecycle: lifecycles[1],
        deliveryCorrelations: [{ begin: beginDiscarded }],
      });
      expect(q.add(incoming)).toBe(false);
      await q.drain();
      expect(q.calls.map((run) => run.prompt)).toEqual(["@bot deploy?", "@bot status?"]);
      for (const [index, room] of [ambient, incoming].entries()) {
        await room.controllerInput?.settlement.promise;
        expect(room.turnAdoptionLifecycle?.onAdopted).toHaveBeenCalledOnce();
        expect(abandoned[index]).not.toHaveBeenCalled();
        expect(room.turnAdoptionLifecycle?.onSettled).toHaveBeenCalledOnce();
      }
      correlation.notify({ sessionKey: q.key, to: "room", ...options });
      correlation.notify({ sessionKey: q.key, to: "room", ...options });
      expect(activeDelivered).toHaveBeenCalledOnce();
      expect(beginDiscarded).not.toHaveBeenCalled();
      endActive();
    },
  );
  it("keeps framing on elided summaries of room events with required replies", async () => {
    const q = createQueueCase({ mode: "followup", cap: 1 }, 3);
    for (const messageId of ["201", "202", "203"]) {
      q.add({
        ...createRun(
          { prompt: `#${messageId} Grace: ambient`, messageId },
          { terminalReplyExpectation: "required" },
        ),
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

  it("bounds an ambient burst without summarizing the older request", async () => {
    const q = createQueueCase({ mode: "followup", cap: 3 }, 3);
    q.add(createRun({ prompt: "@bot deploy?" }));
    for (let index = 0; index < 25; index++) {
      q.add(createRun({ prompt: `room ${index}`, currentInboundEventKind: "room_event" }));
    }
    await q.drain();
    expect(q.calls.map((run) => run.prompt)).toEqual(["@bot deploy?", "room 23", "room 24"]);
  });
});
