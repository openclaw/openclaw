import { describe, expect, it, vi } from "vitest";
import { createInboundEventDeliveryCorrelation } from "../../plugin-sdk/inbound-event-delivery.js";
import { withPluginRuntimeGatewayContextResolver as withGateway } from "../../plugins/runtime/gateway-request-scope.js";
import { createTestUserTurnRecorder } from "./agent-runner-execution.transcript.test-support.js";
import { createQueueCase } from "./queue.case.test-support.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
  rejectQueuePreparation,
} from "./queue.test-helpers.js";
import { clearFollowupQueue } from "./queue/state.js";

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
      const context = q.calls[0]?.currentInboundContext;
      if (dropPolicy === "summarize") {
        expect(context?.text).toContain('"messageId":"ambient"');
        expect(context?.text).toContain('"messageId":"incoming"');
        expect(context?.text).toContain('"text":"lunch?"');
        expect(context?.fragments?.at(-1)?.kind).toBe("conversation-data");
        expect(q.calls[1]?.currentInboundContext).toBeUndefined();
      } else {
        expect(context).toBeUndefined();
      }
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
    const context = q.calls[0]?.currentInboundContext?.text;
    expect(context).toContain('"text":"room 20"');
    expect(context).toContain('"text":"room 22"');
    expect(context).not.toContain('"text":"room 19"');
  });

  it.each(["same", "thread", "account", "gateway"] as const)(
    "preserves bounded cross-sender context only within the same room scope: %s",
    async (scope) => {
      const q = createQueueCase({ mode: "followup", cap: 1 });
      const route = {
        originatingChannel: "telegram" as const,
        originatingTo: "room",
        originatingThreadId: "1",
        originatingAccountId: "default",
      };
      const gatewayA = () => {
        throw new Error("must not resolve gateway");
      };
      const gatewayB = () => {
        throw new Error("must not resolve gateway");
      };
      const request = createRun(
        { prompt: "@bot status?", ...route },
        { senderId: "ada", senderIsOwner: false },
      );
      withGateway(gatewayA, () => q.add(request));
      const ambient = createRun(
        {
          prompt: "raw secret",
          currentInboundEventKind: "room_event",
          ...route,
          ...(scope === "thread" ? { originatingThreadId: "2" } : {}),
          ...(scope === "account" ? { originatingAccountId: "other" } : {}),
          userTurnTranscriptRecorder: {
            ...createTestUserTurnRecorder({ role: "user", content: "raw secret", timestamp: 1 }),
            getPendingInputMessage: () => ({
              role: "user",
              content: "approved " + "x".repeat(180),
              timestamp: 1,
            }),
          },
        },
        { senderName: "Grace", senderId: "grace", senderIsOwner: true },
      );
      withGateway(scope === "gateway" ? gatewayB : gatewayA, () => q.add(ambient));
      await q.drain();
      const context = q.calls[0]?.currentInboundContext?.text;
      if (scope === "same") {
        expect(context).toContain('"sender":"Grace"');
        expect(context).toContain('"text":"approved ' + "x".repeat(150) + '…"');
        expect(context).not.toContain("raw secret");
        expect(context).not.toContain("x".repeat(151));
      } else {
        expect(context).toBeUndefined();
      }
      expect(q.calls[0]?.run.senderId).toBe("ada");
      expect(q.calls[0]?.run.senderIsOwner).toBe(false);
    },
  );

  it("does not bypass an unstaged input hook or append context again on preparation retries", async () => {
    const q = createQueueCase({ mode: "followup", cap: 1 }, 2);
    q.add(
      createRun({ prompt: "@bot status?", currentInboundContext: { text: "original context" } }),
    );
    q.add(
      createRun({
        prompt: "raw secret",
        currentInboundEventKind: "room_event",
        userTurnTranscriptRecorder: createTestUserTurnRecorder({
          role: "user",
          content: "raw secret",
          timestamp: 1,
        }),
      }),
    );
    const contexts: Array<string | undefined> = [];
    await q.drain(async (run) => {
      contexts.push(run.currentInboundContext?.text);
      if (contexts.length === 1) {
        rejectQueuePreparation(run, new Error("synthetic pre-execution refusal"));
      }
      q.done.resolve();
    });
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toContain("original context");
    expect(contexts[0]).toContain("input write hook has not approved");
    expect(contexts[0]).not.toContain("raw secret");
    expect(contexts[1]).toBe(contexts[0]);
  });

  it("expires compacted context when its pending recipient is cleared", async () => {
    const q = createQueueCase({ mode: "followup", cap: 1 });
    const request = createRun({ prompt: "old request" });
    q.add(request);
    q.add(createRun({ prompt: "old ambient", currentInboundEventKind: "room_event" }));
    clearFollowupQueue(q.key);
    await request.controllerInput?.settlement.promise;
    q.add(createRun({ prompt: "new request" }));
    await q.drain();
    expect(q.calls[0]?.prompt).toBe("new request");
    expect(q.calls[0]?.currentInboundContext).toBeUndefined();
  });
});
